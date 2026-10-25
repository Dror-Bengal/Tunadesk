// Launching an agent CLI, shared by the desk's own runner and `tunadesk runner` on other machines.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Actor, Notification, Project, Task } from "../service.js";
import type { TriggerConfig } from "../domain.js";

const OUTPUT_LIMIT = 20_000;

export interface RunResult {
  status: "succeeded" | "failed";
  exit_code: number | null;
  output: string;
  reason?: string;
}

export interface LaunchContext {
  /** Desk URL as seen from the machine running the agent. */
  deskUrl: string;
  /** Path of the tunadesk CLI on that machine (stdio MCP bridge for Codex). */
  cliPath: string;
  actorId: string;
  taskKey: string;
  notificationId: string;
  prompt: string;
  token: string;
  cwd: string;
}

/** Build argv for a CLI agent. Arguments are passed as an array — never through a shell. */
export function buildCommand(trigger: TriggerConfig, ctx: LaunchContext & { scratch?: string }): { command: string; args: string[] } {
  const extra = trigger.args ?? [];
  const mcpUrl = `${ctx.deskUrl}/mcp`;
  switch (trigger.type) {
    case "claude": {
      const mcpConfig = JSON.stringify({ mcpServers: { tunadesk: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${ctx.token}` } } } });
      // A private file keeps the run token out of `ps` output.
      let configArg = mcpConfig;
      if (ctx.scratch) {
        configArg = join(ctx.scratch, "mcp.json");
        writeFileSync(configArg, mcpConfig, { mode: 0o600 });
      }
      const args = ["-p", ctx.prompt, "--mcp-config", configArg, "--output-format", "text"];
      if (trigger.model) args.push("--model", trigger.model);
      args.push(...(extra.length ? extra : ["--permission-mode", "acceptEdits", "--allowedTools", "mcp__tunadesk"]));
      return { command: trigger.command || resolveBinary("claude", [join(homedir(), ".claude", "local", "claude")]), args };
    }
    case "codex": {
      const toml = (v: string) => JSON.stringify(v); // TOML basic strings share JSON escaping for our inputs
      const args = [
        "exec",
        "--skip-git-repo-check",
        "-c",
        `mcp_servers.tunadesk.command=${toml(process.execPath)}`,
        "-c",
        `mcp_servers.tunadesk.args=[${toml(ctx.cliPath)}, "mcp"]`,
        "-c",
        `mcp_servers.tunadesk.env={ TUNADESK_URL = ${toml(ctx.deskUrl)}, TUNADESK_TOKEN = ${toml(ctx.token)} }`,
      ];
      if (trigger.model) args.push("--model", trigger.model);
      args.push(...(extra.length ? extra : ["--full-auto"]));
      args.push(ctx.prompt);
      return { command: trigger.command || resolveBinary("codex"), args };
    }
    case "grok": {
      // grok-cli (github.com/superagent-ai/grok-cli): headless with --prompt; MCP is configured once with `grok mcp add`.
      const args = ["--prompt", ctx.prompt, "--directory", ctx.cwd];
      if (trigger.model) args.push("--model", trigger.model);
      args.push(...extra);
      return { command: trigger.command || resolveBinary("grok"), args };
    }
    case "command": {
      if (!trigger.command) throw new Error("command trigger needs a command");
      const vars: Record<string, string> = {
        prompt: ctx.prompt,
        task: ctx.taskKey,
        actor: ctx.actorId,
        url: ctx.deskUrl,
        mcp_url: mcpUrl,
        cwd: ctx.cwd,
        notification: ctx.notificationId,
      };
      const args = (extra.length ? extra : ["{prompt}"]).map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
      return { command: trigger.command, args };
    }
    default:
      throw new Error(`unsupported trigger type ${trigger.type}`);
  }
}

/** Launch the agent in `cwd`, capture its output and wait for it (bounded by the trigger timeout). */
export async function launchAgent(trigger: TriggerConfig, ctx: LaunchContext, onStart?: (kill: () => void) => void): Promise<RunResult> {
  const scratch = mkdtempSync(join(tmpdir(), "tunadesk-run-"));
  try {
    const { command, args } = buildCommand(trigger, { ...ctx, scratch });
    return await spawnCaptured(command, args, {
      cwd: ctx.cwd,
      env: { TUNADESK_URL: ctx.deskUrl, TUNADESK_TOKEN: ctx.token, TUNADESK_AGENT: ctx.actorId, TUNADESK_TASK: ctx.taskKey },
      timeoutMs: (trigger.timeout_minutes ?? 30) * 60_000,
      onStart,
    });
  } catch (err) {
    return { status: "failed", exit_code: null, output: String((err as Error).message), reason: "could not start" };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function spawnCaptured(
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; onStart?: (kill: () => void) => void },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
    };
    const child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);
    opts.onStart?.(() => child.kill("SIGTERM"));
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      clearTimeout(timer);
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve({ status: "failed", exit_code: null, output: output + String(err.message), reason: missing ? `${command} not found — install it or set the trigger command` : "spawn error" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        status: code === 0 && !timedOut ? "succeeded" : "failed",
        exit_code: code,
        output: output.slice(-OUTPUT_LIMIT),
        reason: timedOut ? `timed out after ${Math.round(opts.timeoutMs / 60000)} min` : undefined,
      });
    });
  });
}

export function buildPrompt(actor: Actor, notifications: Notification[], task: Task | null, project: Project | null, deskUrl: string): string {
  const why = notifications
    .map((n) => `- ${n.type}${n.task_key ? ` on ${n.task_key}` : ""} from @${n.sender ?? "system"}: ${n.message.replace(/\s+/g, " ").slice(0, 500)}`)
    .join("\n");
  return [
    `You are @${actor.id} (${actor.name}), a ${actor.role} agent on Tunadesk — the shared task desk for this human's agents.`,
    actor.description ? `Your standing instructions: ${actor.description}` : "",
    "",
    "You were woken up because:",
    why,
    "",
    task ? `Focus task: ${task.key} — ${task.title} (project ${project?.key ?? task.project_key}).` : "",
    "",
    "How to work:",
    "1. Call the tunadesk `briefing` tool, then `get_task` for the focus task to read the full thread.",
    "2. `claim_task` before changing anything, then do the work in this repository.",
    "3. Post short progress notes with `comment`; log non-obvious choices with `log_decision`.",
    "4. Finish with `complete_task` (what changed + how verified + tokens_used) or `handoff_task` to the right teammate (e.g. to the tester when code is ready, with bug sub-tasks back to the developer when testing fails).",
    "5. If you cannot proceed, `comment` why and `release_task`. Do not leave the task claimed.",
    "",
    `If the tunadesk MCP tools are not available, use the REST API at $TUNADESK_URL (${deskUrl}) with header "Authorization: Bearer $TUNADESK_TOKEN"; GET $TUNADESK_URL/llms.txt lists the endpoints.`,
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace("\nYou were woken", "\n\nYou were woken")
    .replace("\nHow to work", "\n\nHow to work");
}

/** Find an executable on PATH (shell aliases are invisible to spawn), with fallbacks. */
export function resolveBinary(name: string, fallbacks: string[] = []): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  for (const f of fallbacks) if (existsSync(f)) return f;
  return name;
}
