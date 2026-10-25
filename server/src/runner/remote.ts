// `tunadesk runner`: runs on an agent's own machine, listens to the desk with that agent's token and
// launches the agent locally when it is woken. Works across machines and with a desk inside Docker.
import { existsSync } from "node:fs";
import type { TriggerConfig } from "../domain.js";
import { launchAgent, type RunResult } from "./launch.js";
import type { WakeOrder } from "./runner.js";

export interface RemoteRunnerOptions {
  /** Desk URL as reachable from this machine. */
  url: string;
  /** One agent token per agent hosted on this machine. */
  tokens: string[];
  /** Project key → local checkout path (repo paths on the desk usually differ per machine). */
  repos: Record<string, string>;
  /** Shown on the desk as "runner online: <name>". */
  name: string;
  /** Path of this machine's tunadesk CLI (stdio MCP bridge for Codex). */
  cliPath: string;
  log?: (msg: string) => void;
  /** Launcher override (tests). */
  launch?: typeof launchAgent;
}

export interface RemoteRunnerHandle {
  /** Resolves once every agent stream has said hello (or failed authentication). */
  ready: Promise<void>;
  stop: () => void;
}

export function startRemoteRunner(opts: RemoteRunnerOptions): RemoteRunnerHandle {
  const log = opts.log ?? ((m: string) => console.log(`[runner] ${m}`));
  const base = opts.url.replace(/\/$/, "");
  const controllers: AbortController[] = [];
  let stopped = false;
  const readies = opts.tokens.map(
    (token) =>
      new Promise<void>((resolve) => {
        const controller = new AbortController();
        controllers.push(controller);
        void connectLoop(token, controller.signal, resolve);
      }),
  );

  async function connectLoop(token: string, signal: AbortSignal, ready: () => void) {
    let delay = 1000;
    let agent = "?";
    while (!stopped) {
      try {
        const res = await fetch(`${base}/api/runner/stream?name=${encodeURIComponent(opts.name)}`, {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
          signal,
        });
        if (res.status === 401 || res.status === 400) {
          log(`token ${token.slice(0, 8)}… was rejected (${res.status}) — is it an agent token for this desk?`);
          ready();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        delay = 1000;
        for await (const { event, data } of readSse(res.body)) {
          if (event === "hello") {
            const hello = JSON.parse(data) as { actor: string; trigger: TriggerConfig };
            agent = hello.actor;
            log(`connected as @${agent} (${hello.trigger.type}${hello.trigger.enabled ? "" : ", trigger disabled on the desk"})`);
            ready();
          } else if (event === "wake") {
            // One run at a time per agent: the desk never sends a second order before this one finishes.
            await handleWake(token, JSON.parse(data) as WakeOrder);
          }
        }
        if (!stopped) log(`@${agent}: stream closed, reconnecting…`);
      } catch (err) {
        if (stopped) return;
        log(`@${agent}: ${(err as Error).message} — retrying in ${Math.round(delay / 1000)}s`);
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  function resolveCwd(order: WakeOrder): string | null {
    const candidates = [order.project ? opts.repos[order.project.key] ?? opts.repos[order.project.key.toLowerCase()] : undefined, order.trigger.cwd, order.project?.repo_path];
    return candidates.find((p): p is string => Boolean(p && existsSync(p))) ?? null;
  }

  async function handleWake(token: string, order: WakeOrder) {
    const label = `@${order.actor.id}${order.task ? ` ${order.task.key}` : ""}`;
    const cwd = resolveCwd(order);
    let result: RunResult;
    if (!cwd) {
      const key = order.project?.key ?? "PROJECT";
      result = { status: "failed", exit_code: null, output: "", reason: `no local checkout for ${key} on "${opts.name}" — start the runner with --repo ${key}=/path/to/repo` };
      log(`${label}: ${result.reason}`);
    } else {
      log(`${label}: launching ${order.trigger.type} in ${cwd}`);
      result = await (opts.launch ?? launchAgent)(order.trigger as TriggerConfig, {
        deskUrl: base,
        cliPath: opts.cliPath,
        actorId: order.actor.id,
        taskKey: order.task?.key ?? "",
        notificationId: order.notification_id,
        prompt: order.prompt,
        token: order.token,
        cwd,
      });
      log(`${label}: ${result.status}${result.exit_code !== null ? ` (exit ${result.exit_code})` : ""}${result.reason ? ` — ${result.reason}` : ""}`);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${base}/api/runner/runs/${order.run_id}/finish`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(result),
        });
        if (res.ok || res.status === 404) return;
      } catch {
        /* desk unreachable — retry */
      }
      await sleep(2000 * (attempt + 1));
    }
    log(`${label}: could not report the result to the desk`);
  }

  return {
    ready: Promise.all(readies).then(() => undefined),
    stop: () => {
      stopped = true;
      controllers.forEach((c) => c.abort());
    },
  };
}

/** Minimal Server-Sent Events parser over a fetch body. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
