// The runner turns inbox notifications into actual agent runs: when a tester hands bugs to @claude-dev,
// the runner launches Claude Code headless in the project's repo with a prompt that points it at the desk.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Service, Actor, Activity, Notification, Task, Project } from "../service.js";
import { WAKING_NOTIFICATIONS, type NotificationType, type TriggerConfig } from "../domain.js";

export interface RunnerOptions {
  /** Base URL agents use to reach the desk (REST + /mcp). */
  deskUrl: string;
  /** Absolute path of the tunadesk CLI entry, used to launch the stdio MCP bridge for Codex/Grok. */
  cliPath: string;
  /** Wait this long after a wake-up to batch related notifications. */
  debounceMs?: number;
  /** Per-actor ceiling on runs per hour. */
  maxRunsPerHour?: number;
  /** Per-task ceiling on runs per hour (ping-pong protection). */
  maxRunsPerTaskPerHour?: number;
  log?: (msg: string) => void;
}

interface Pending {
  notifications: Notification[];
  timer?: NodeJS.Timeout;
}

const OUTPUT_LIMIT = 20_000;

export class Runner {
  private pending = new Map<string, Pending>();
  private active = new Map<string, { kill: () => void }>();
  private listener = (e: Activity) => this.onEvent(e);
  private opts: Required<Omit<RunnerOptions, "log">> & { log: (msg: string) => void };

  constructor(
    private svc: Service,
    opts: RunnerOptions,
  ) {
    this.opts = {
      deskUrl: opts.deskUrl,
      cliPath: opts.cliPath,
      debounceMs: opts.debounceMs ?? 3000,
      maxRunsPerHour: opts.maxRunsPerHour ?? 12,
      maxRunsPerTaskPerHour: opts.maxRunsPerTaskPerHour ?? 4,
      log: opts.log ?? ((m) => console.log(`[runner] ${m}`)),
    };
  }

  start() {
    this.svc.events.on("event", this.listener);
    this.opts.log(`watching for wake-ups (desk ${this.opts.deskUrl})`);
  }

  stop() {
    this.svc.events.off("event", this.listener);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    for (const a of this.active.values()) a.kill();
  }

  /** Is a run currently executing for this actor? */
  isBusy(actorId: string) {
    return this.active.has(actorId);
  }

  private onEvent(e: Activity) {
    if (e.type !== "notification" || !e.data.wakes) return;
    const actor = this.svc.findActor(String(e.data.recipient));
    if (!actor || actor.kind !== "agent") return;
    const trigger = actor.trigger;
    if (!trigger.enabled || trigger.type === "none") return;
    const on = trigger.on?.length ? trigger.on : WAKING_NOTIFICATIONS;
    if (!on.includes(e.data.type as NotificationType)) return;
    // The actor who caused the event never wakes itself.
    if (e.actor === actor.id) return;
    let n: Notification;
    try {
      n = this.svc.notification(String(e.data.notification));
    } catch {
      return;
    }
    const p = this.pending.get(actor.id) ?? { notifications: [] };
    p.notifications.push(n);
    this.pending.set(actor.id, p);
    if (this.active.has(actor.id)) return; // picked up when the current run ends
    clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.flush(actor.id), this.opts.debounceMs);
  }

  /** Run now for whatever is pending for this actor (exposed for tests and the "wake" button). */
  async flush(actorId: string): Promise<void> {
    const p = this.pending.get(actorId);
    if (!p || !p.notifications.length || this.active.has(actorId)) return;
    clearTimeout(p.timer);
    this.pending.delete(actorId);
    const actor = this.svc.findActor(actorId);
    if (!actor) return;
    try {
      await this.execute(actor, p.notifications);
    } catch (err) {
      this.opts.log(`run for ${actorId} crashed: ${(err as Error).message}`);
    }
    // Anything that arrived while we were running gets its own run.
    const next = this.pending.get(actorId);
    if (next?.notifications.length) {
      clearTimeout(next.timer);
      next.timer = setTimeout(() => void this.flush(actorId), this.opts.debounceMs);
    }
  }

  private guard(actor: Actor, task: Task | null): string | null {
    const trigger = actor.trigger;
    if (this.svc.recentRunCount(actor.id, null, 60) >= this.opts.maxRunsPerHour) return `rate limit: ${this.opts.maxRunsPerHour} runs/hour`;
    if (task && this.svc.recentRunCount(actor.id, task.id, 60) >= this.opts.maxRunsPerTaskPerHour)
      return `loop protection: ${task.key} already woke ${actor.id} ${this.opts.maxRunsPerTaskPerHour} times this hour`;
    if (trigger.respect_budget !== false) {
      const b = this.svc.budget(actor.id);
      if (b.remaining !== null && b.remaining <= 0 && task?.priority !== "critical") return `out of ${b.period}ly token budget (${b.used}/${b.budget})`;
    }
    if (task && ["done", "canceled"].includes(task.status)) return `${task.key} is already ${task.status}`;
    return null;
  }

  private async execute(actor: Actor, notifications: Notification[]) {
    const trigger = actor.trigger;
    const primary = notifications.find((n) => n.task_id) ?? notifications[0];
    const task = primary.task_id ? this.safeTask(primary.task_id) : null;
    const project = task ? this.svc.project(task.project_id) : primary.project_id ? this.safeProject(primary.project_id) : null;

    const blocked = this.guard(actor, task);
    if (blocked) {
      this.svc.createRun({ actor: actor.id, task_id: task?.id, notification_id: primary.id, trigger_type: trigger.type, status: "skipped", reason: blocked });
      this.opts.log(`skip ${actor.id}: ${blocked}`);
      return;
    }

    const cwd = trigger.cwd || project?.repo_path || "";
    if (trigger.type !== "webhook" && (!cwd || !existsSync(cwd))) {
      const reason = cwd ? `working directory ${cwd} does not exist` : `project ${project?.key ?? "?"} has no repo path (set it on the project or in the agent's trigger)`;
      this.svc.createRun({ actor: actor.id, task_id: task?.id, notification_id: primary.id, trigger_type: trigger.type, status: "skipped", reason });
      return;
    }

    const ttl = (trigger.timeout_minutes ?? 30) + 30;
    const token = this.svc.issueEphemeralToken(actor.id, ttl);
    const prompt = buildPrompt(actor, notifications, task, project, this.opts.deskUrl);
    const run = this.svc.createRun({ actor: actor.id, task_id: task?.id, notification_id: primary.id, trigger_type: trigger.type, reason: notifications.map((n) => n.type).join(", ") });
    this.svc.touchActor(actor.id, "working", task ? `woken for ${task.key}` : "woken");
    this.svc.markRead(actor.id, notifications.map((n) => n.id));
    this.opts.log(`waking ${actor.id} via ${trigger.type}${task ? ` for ${task.key}` : ""}`);

    try {
      if (trigger.type === "webhook") {
        const result = await this.webhook(trigger, { actor, notifications, task, project, prompt, token });
        this.svc.finishRun(run.id, result);
        this.reportFailure(actor, task, result);
      } else {
        const { command, args } = this.commandFor(trigger, { actor, task, prompt, token, cwd, notification: primary });
        const result = await this.spawnRun(actor.id, command, args, {
          cwd,
          env: { TUNADESK_URL: this.opts.deskUrl, TUNADESK_TOKEN: token, TUNADESK_AGENT: actor.id, TUNADESK_TASK: task?.key ?? "" },
          timeoutMs: (trigger.timeout_minutes ?? 30) * 60_000,
        });
        this.svc.finishRun(run.id, result);
        this.reportFailure(actor, task, result);
      }
    } catch (err) {
      const failure = { status: "failed" as const, output: String((err as Error).message), reason: "runner error" };
      this.svc.finishRun(run.id, failure);
      this.reportFailure(actor, task, failure);
    } finally {
      this.svc.revokeEphemeralToken(token);
      const now = this.svc.findActor(actor.id);
      if (now?.status === "working" && now.status_note.startsWith("woken")) this.svc.touchActor(actor.id, "idle", "");
    }
  }

  /** Tell the human when a wake-up did not work, so failures never go unnoticed. */
  private reportFailure(actor: Actor, task: Task | null, result: { status: string; reason?: string; output?: string }) {
    if (result.status !== "failed") return;
    const tail = (result.output ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
    this.svc.notify(this.svc.settings().owner, "run_failed", {
      sender: actor.id,
      task_id: task?.id ?? null,
      project_id: task?.project_id ?? null,
      message: `Wake-up of @${actor.id} via ${actor.trigger.type} failed${result.reason ? ` (${result.reason})` : ""}${tail ? `: ${tail}` : ""}`,
    });
  }

  private safeTask(id: string): Task | null {
    try {
      return this.svc.task(id);
    } catch {
      return null;
    }
  }

  private safeProject(id: string): Project | null {
    try {
      return this.svc.project(id);
    } catch {
      return null;
    }
  }

  /** Build argv for a CLI agent. Arguments are passed as an array — never through a shell. */
  commandFor(
    trigger: TriggerConfig,
    ctx: { actor: Actor; task: Task | null; prompt: string; token: string; cwd: string; notification: Notification },
  ): { command: string; args: string[] } {
    const extra = trigger.args ?? [];
    const mcpUrl = `${this.opts.deskUrl}/mcp`;
    switch (trigger.type) {
      case "claude": {
        const mcpConfig = JSON.stringify({ mcpServers: { tunadesk: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${ctx.token}` } } } });
        const args = ["-p", ctx.prompt, "--mcp-config", mcpConfig, "--output-format", "text"];
        if (trigger.model) args.push("--model", trigger.model);
        args.push(...(extra.length ? extra : ["--permission-mode", "acceptEdits", "--allowedTools", "mcp__tunadesk"]));
        return { command: trigger.command || resolveBinary("claude", [join(homedir(), ".claude", "local", "claude")]), args };
      }
      case "codex": {
        const node = process.execPath;
        const toml = (v: string) => JSON.stringify(v); // TOML basic strings share JSON escaping for our inputs
        const args = [
          "exec",
          "--skip-git-repo-check",
          "-c",
          `mcp_servers.tunadesk.command=${toml(node)}`,
          "-c",
          `mcp_servers.tunadesk.args=[${toml(this.opts.cliPath)}, "mcp"]`,
          "-c",
          `mcp_servers.tunadesk.env={ TUNADESK_URL = ${toml(this.opts.deskUrl)}, TUNADESK_TOKEN = ${toml(ctx.token)} }`,
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
          task: ctx.task?.key ?? "",
          actor: ctx.actor.id,
          url: this.opts.deskUrl,
          mcp_url: mcpUrl,
          cwd: ctx.cwd,
          notification: ctx.notification.id,
        };
        const args = (extra.length ? extra : ["{prompt}"]).map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
        return { command: trigger.command, args };
      }
      default:
        throw new Error(`unsupported trigger type ${trigger.type}`);
    }
  }

  private spawnRun(
    actorId: string,
    command: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
  ): Promise<{ status: "succeeded" | "failed"; exit_code: number | null; output: string; reason?: string }> {
    return new Promise((resolve) => {
      let output = "";
      const append = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
      };
      let child;
      try {
        child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        resolve({ status: "failed", exit_code: null, output: String((err as Error).message), reason: "could not start" });
        return;
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, opts.timeoutMs);
      this.active.set(actorId, { kill: () => child.kill("SIGTERM") });
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("error", (err) => {
        clearTimeout(timer);
        this.active.delete(actorId);
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        resolve({ status: "failed", exit_code: null, output: output + String(err.message), reason: missing ? `${command} not found — install it or set the trigger command` : "spawn error" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        this.active.delete(actorId);
        resolve({
          status: code === 0 && !timedOut ? "succeeded" : "failed",
          exit_code: code,
          output: output.slice(-OUTPUT_LIMIT),
          reason: timedOut ? `timed out after ${Math.round(opts.timeoutMs / 60000)} min` : undefined,
        });
      });
    });
  }

  private async webhook(
    trigger: TriggerConfig,
    ctx: { actor: Actor; notifications: Notification[]; task: Task | null; project: Project | null; prompt: string; token: string },
  ): Promise<{ status: "succeeded" | "failed"; exit_code: number | null; output: string; reason?: string }> {
    if (!trigger.url) return { status: "failed", exit_code: null, output: "", reason: "webhook trigger needs a url" };
    const payload = JSON.stringify({
      event: "tunadesk.wake",
      desk_url: this.opts.deskUrl,
      mcp_url: `${this.opts.deskUrl}/mcp`,
      agent: { id: ctx.actor.id, name: ctx.actor.name, platform: ctx.actor.platform, role: ctx.actor.role },
      token: ctx.token,
      token_expires_in_minutes: (trigger.timeout_minutes ?? 30) + 30,
      notifications: ctx.notifications,
      task: ctx.task,
      project: ctx.project ? { key: ctx.project.key, name: ctx.project.name, repo_path: ctx.project.repo_path, repo_url: ctx.project.repo_url } : null,
      prompt: ctx.prompt,
    });
    const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "tunadesk-runner" };
    if (trigger.secret) headers["x-tunadesk-signature"] = "sha256=" + createHmac("sha256", trigger.secret).update(payload).digest("hex");
    try {
      const res = await fetch(trigger.url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(30_000) });
      const text = (await res.text()).slice(0, 4000);
      return { status: res.ok ? "succeeded" : "failed", exit_code: res.status, output: text };
    } catch (err) {
      return { status: "failed", exit_code: null, output: String((err as Error).message), reason: "webhook unreachable" };
    }
  }
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
