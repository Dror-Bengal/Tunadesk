// The runner turns inbox notifications into actual agent runs: when a tester hands bugs to @claude-dev,
// the runner launches Claude Code headless in the project's repo with a prompt that points it at the desk.
// Runs happen either here (the desk's machine) or on the agent's own machine via `tunadesk runner`.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Service, Actor, Activity, Notification, Task, Project } from "../service.js";
import { WAKING_NOTIFICATIONS, type NotificationType, type TriggerConfig } from "../domain.js";
import { buildPrompt, launchAgent, type RunResult } from "./launch.js";

export { buildPrompt, resolveBinary } from "./launch.js";

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

/** What a remote runner receives when its agent should wake up. Never includes webhook secrets. */
export interface WakeOrder {
  run_id: string;
  actor: { id: string; name: string; role: string };
  trigger: Pick<TriggerConfig, "type" | "command" | "args" | "model" | "cwd" | "timeout_minutes">;
  prompt: string;
  token: string;
  token_ttl_minutes: number;
  notification_id: string;
  task: { key: string; title: string } | null;
  project: { key: string; name: string; repo_path: string; repo_url: string } | null;
}

interface RemoteConnection {
  id: string;
  actor: string;
  name: string;
  since: string;
  send: (event: string, data: unknown) => boolean;
}

interface Pending {
  notifications: Notification[];
  timer?: NodeJS.Timeout;
}

export class Runner {
  private pending = new Map<string, Pending>();
  private active = new Map<string, { kill: () => void }>();
  private remotes = new Map<string, Map<string, RemoteConnection>>();
  private remoteRuns = new Map<string, { actor: string; token: string; task: Task | null; timer: NodeJS.Timeout; conn: string }>();
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
    for (const r of this.remoteRuns.values()) clearTimeout(r.timer);
  }

  /** Is a run currently executing for this actor? */
  isBusy(actorId: string) {
    return this.active.has(actorId);
  }

  // ------------------------------------------------------------------ remote runners

  /** A `tunadesk runner` connected for this agent. Returns a function that detaches it. */
  attachRemote(actorId: string, name: string, send: RemoteConnection["send"]): () => void {
    const conn: RemoteConnection = { id: randomUUID(), actor: actorId, name: name || "runner", since: new Date().toISOString(), send };
    const conns = this.remotes.get(actorId) ?? new Map<string, RemoteConnection>();
    conns.set(conn.id, conn);
    this.remotes.set(actorId, conns);
    this.svc.touchActor(actorId, this.svc.findActor(actorId)?.status === "working" ? "working" : "idle");
    this.opts.log(`remote runner "${conn.name}" online for ${actorId}`);
    this.catchUp(actorId);
    return () => {
      conns.delete(conn.id);
      if (!conns.size) this.remotes.delete(actorId);
      this.opts.log(`remote runner "${conn.name}" offline for ${actorId}`);
      // A run handed to this connection can no longer be reported: free the agent now instead of at the timeout.
      for (const [runId, r] of this.remoteRuns) {
        if (r.conn === conn.id) this.finishRemote(runId, actorId, { status: "failed", exit_code: null, output: "", reason: `runner "${conn.name}" disconnected during the run` });
      }
    };
  }

  remoteStatus(actorId: string): Array<{ name: string; since: string }> {
    return [...(this.remotes.get(actorId)?.values() ?? [])].map((c) => ({ name: c.name, since: c.since }));
  }

  /** A remote runner reports the outcome of a run it was given. */
  finishRemote(runId: string, actorId: string, result: RunResult): boolean {
    const r = this.remoteRuns.get(runId);
    if (!r || r.actor !== actorId) return false;
    this.remoteRuns.delete(runId);
    clearTimeout(r.timer);
    this.svc.finishRun(runId, result);
    this.reportFailure(actorId, r.task, result);
    this.endRun(actorId, r.token, true);
    return true;
  }

  /** Wake-ups that arrived while an agent's runner was offline are still unread: deliver them now. */
  private catchUp(actorId: string) {
    const actor = this.svc.findActor(actorId);
    if (!actor || !this.wantsWakeups(actor)) return;
    const on = actor.trigger.on?.length ? actor.trigger.on : WAKING_NOTIFICATIONS;
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const missed = this.svc
      .inbox(actorId, { unread_only: true, limit: 20 })
      .filter((n) => on.includes(n.type) && n.sender !== actorId && n.created_at >= since)
      .reverse();
    if (!missed.length) return;
    const p = this.pending.get(actorId) ?? { notifications: [] };
    for (const n of missed) if (!p.notifications.some((x) => x.id === n.id)) p.notifications.push(n);
    this.pending.set(actorId, p);
    this.schedule(actorId);
  }

  // ------------------------------------------------------------------ dispatch

  private wantsWakeups(actor: Actor) {
    return actor.kind === "agent" && actor.trigger.enabled && actor.trigger.type !== "none";
  }

  private onEvent(e: Activity) {
    if (e.type !== "notification" || !e.data.wakes) return;
    const actor = this.svc.findActor(String(e.data.recipient));
    if (!actor || !this.wantsWakeups(actor)) return;
    const on = actor.trigger.on?.length ? actor.trigger.on : WAKING_NOTIFICATIONS;
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
    this.schedule(actor.id);
  }

  private schedule(actorId: string) {
    const p = this.pending.get(actorId);
    if (!p || this.active.has(actorId)) return; // picked up when the current run ends
    clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.flush(actorId), this.opts.debounceMs);
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
    if (!this.active.has(actorId)) this.schedule(actorId);
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
    // Full config (including the webhook secret), which API responses never carry.
    const trigger = this.svc.triggerConfig(actor.id);
    const where = trigger.where ?? "auto";
    const remote = trigger.type !== "webhook" && where !== "desk" ? this.pickRemote(actor.id) : null;
    if (!remote && where === "remote" && trigger.type !== "webhook") {
      // Leave the notifications unread: the agent's runner delivers them when it reconnects.
      this.opts.log(`holding wake-up for ${actor.id} until its runner is online`);
      return;
    }

    const primary = notifications.find((n) => n.task_id) ?? notifications[0];
    const task = primary.task_id ? this.safeTask(primary.task_id) : null;
    const project = task ? this.svc.project(task.project_id) : primary.project_id ? this.safeProject(primary.project_id) : null;

    const blocked = this.guard(actor, task);
    if (blocked) {
      this.svc.createRun({ actor: actor.id, task_id: task?.id, notification_id: primary.id, trigger_type: trigger.type, status: "skipped", reason: blocked });
      this.svc.markRead(actor.id, notifications.map((n) => n.id));
      this.opts.log(`skip ${actor.id}: ${blocked}`);
      return;
    }

    const cwd = trigger.cwd || project?.repo_path || "";
    if (!remote && trigger.type !== "webhook" && (!cwd || !existsSync(cwd))) {
      const reason = cwd ? `working directory ${cwd} does not exist on the desk's machine` : `project ${project?.key ?? "?"} has no repo path (set it on the project or in the agent's trigger)`;
      this.svc.createRun({ actor: actor.id, task_id: task?.id, notification_id: primary.id, trigger_type: trigger.type, status: "skipped", reason });
      return;
    }

    const ttl = (trigger.timeout_minutes ?? 30) + 30;
    const token = this.svc.issueEphemeralToken(actor.id, ttl);
    const prompt = buildPrompt(actor, notifications, task, project, this.opts.deskUrl);
    const run = this.svc.createRun({
      actor: actor.id,
      task_id: task?.id,
      notification_id: primary.id,
      trigger_type: trigger.type,
      reason: `${notifications.map((n) => n.type).join(", ")}${remote ? ` · on ${remote.name}` : ""}`,
    });
    this.svc.touchActor(actor.id, "working", task ? `woken for ${task.key}` : "woken");
    this.svc.markRead(actor.id, notifications.map((n) => n.id));
    this.opts.log(`waking ${actor.id} via ${trigger.type}${remote ? ` on ${remote.name}` : ""}${task ? ` for ${task.key}` : ""}`);

    if (remote) {
      const order: WakeOrder = {
        run_id: run.id,
        actor: { id: actor.id, name: actor.name, role: actor.role },
        trigger: { type: trigger.type, command: trigger.command, args: trigger.args, model: trigger.model, cwd: trigger.cwd, timeout_minutes: trigger.timeout_minutes },
        prompt,
        token,
        token_ttl_minutes: ttl,
        notification_id: primary.id,
        task: task ? { key: task.key, title: task.title } : null,
        project: project ? { key: project.key, name: project.name, repo_path: project.repo_path, repo_url: project.repo_url } : null,
      };
      // If the runner never reports back (machine slept, process killed), fail the run instead of blocking the agent forever.
      const timer = setTimeout(() => {
        if (!this.remoteRuns.has(run.id)) return;
        this.finishRemote(run.id, actor.id, { status: "failed", exit_code: null, output: "", reason: `runner "${remote.name}" did not report back` });
      }, ((trigger.timeout_minutes ?? 30) + 10) * 60_000);
      timer.unref();
      this.remoteRuns.set(run.id, { actor: actor.id, token, task, timer, conn: remote.id });
      this.active.set(actor.id, { kill: () => {} });
      if (!remote.send("wake", order)) {
        this.finishRemote(run.id, actor.id, { status: "failed", exit_code: null, output: "", reason: `runner "${remote.name}" disconnected` });
      }
      return;
    }

    let keepToken = false;
    try {
      let result: RunResult;
      if (trigger.type === "webhook") {
        // The receiver usually acks and works asynchronously: leave the token valid until its TTL.
        keepToken = true;
        result = await this.webhook(trigger, { actor, notifications, task, project, prompt, token });
      } else {
        result = await launchAgent(
          trigger,
          { deskUrl: this.opts.deskUrl, cliPath: this.opts.cliPath, actorId: actor.id, taskKey: task?.key ?? "", notificationId: primary.id, prompt, token, cwd },
          (kill) => this.active.set(actor.id, { kill }),
        );
      }
      this.svc.finishRun(run.id, result);
      this.reportFailure(actor.id, task, result);
    } catch (err) {
      const failure = { status: "failed" as const, exit_code: null, output: String((err as Error).message), reason: "runner error" };
      this.svc.finishRun(run.id, failure);
      this.reportFailure(actor.id, task, failure);
    } finally {
      this.endRun(actor.id, token, !keepToken);
    }
  }

  private pickRemote(actorId: string): RemoteConnection | null {
    const conns = [...(this.remotes.get(actorId)?.values() ?? [])];
    return conns.at(-1) ?? null;
  }

  private endRun(actorId: string, token: string, revoke: boolean) {
    if (revoke) this.svc.revokeEphemeralToken(token);
    this.active.delete(actorId);
    const now = this.svc.findActor(actorId);
    if (now?.status === "working" && now.status_note.startsWith("woken")) this.svc.touchActor(actorId, "idle", "");
    this.schedule(actorId);
  }

  /** Tell the human when a wake-up did not work, so failures never go unnoticed. */
  private reportFailure(actorId: string, task: Task | null, result: { status: string; reason?: string; output?: string }) {
    if (result.status !== "failed") return;
    const actor = this.svc.findActor(actorId);
    const tail = (result.output ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
    this.svc.notify(this.svc.settings().owner, "run_failed", {
      sender: actorId,
      task_id: task?.id ?? null,
      project_id: task?.project_id ?? null,
      message: `Wake-up of @${actorId} via ${actor?.trigger.type ?? "trigger"} failed${result.reason ? ` (${result.reason})` : ""}${tail ? `: ${tail}` : ""}`,
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

  private async webhook(
    trigger: TriggerConfig,
    ctx: { actor: Actor; notifications: Notification[]; task: Task | null; project: Project | null; prompt: string; token: string },
  ): Promise<RunResult> {
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
