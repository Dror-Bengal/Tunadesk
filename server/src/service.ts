import { EventEmitter } from "node:events";
import type { DB } from "./db/index.js";
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  PRIORITY_WEIGHT,
  TASK_STATUSES,
  WAKING_NOTIFICATIONS,
  badRequest,
  conflict,
  notFound,
  type DecisionStatus,
  type NotificationType,
  type Priority,
  type ProjectStatus,
  type TaskStatus,
  type TaskType,
  type TriggerConfig,
} from "./domain.js";
import {
  deriveKey,
  extractMentions,
  hashToken,
  newId,
  newToken,
  now,
  parseJson,
  periodStart,
  plain,
  slugify,
  truncate,
} from "./util.js";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface Actor {
  /** Trigger config as shown to clients: the webhook secret is never included (see has_secret). */
  id: string;
  name: string;
  kind: "human" | "agent";
  platform: string;
  role: string;
  color: string;
  emoji: string;
  description: string;
  token_budget: number;
  budget_period: "day" | "week" | "month";
  status: string;
  status_note: string;
  last_seen_at: string | null;
  trigger: TriggerConfig & { has_secret?: boolean };
  has_token: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  status: ProjectStatus;
  priority: Priority;
  repo_path: string;
  repo_url: string;
  owner: string | null;
  brief: string;
  created_at: string;
  updated_at: string;
}

export interface Group {
  id: string;
  project_id: string;
  name: string;
  color: string;
  position: number;
  collapsed: boolean;
}

export interface Task {
  id: string;
  key: string;
  number: number;
  project_id: string;
  project_key: string;
  group_id: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  type: TaskType;
  assignee: string | null;
  reporter: string | null;
  parent_id: string | null;
  parent_key: string | null;
  tags: string[];
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  estimate_tokens: number;
  tokens_used: number;
  position: number;
  lease_holder: string | null;
  lease_expires_at: string | null;
  handoff_count: number;
  blocked_by: string[];
  blocks: string[];
  subtask_count: number;
  subtasks_done: number;
  comment_count: number;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  task_id: string;
  author: string | null;
  kind: "comment" | "handoff" | "report" | "system";
  body: string;
  created_at: string;
}

export interface Decision {
  id: string;
  ref: string;
  number: number;
  project_id: string | null;
  project_key: string | null;
  task_id: string | null;
  task_key: string | null;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  alternatives: string;
  status: DecisionStatus;
  author: string | null;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  recipient: string;
  sender: string | null;
  type: NotificationType;
  task_id: string | null;
  task_key: string | null;
  task_title: string | null;
  project_id: string | null;
  message: string;
  read_at: string | null;
  created_at: string;
}

export interface Activity {
  id: number;
  actor: string | null;
  type: string;
  project_id: string | null;
  task_id: string | null;
  task_key?: string | null;
  summary: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface Run {
  id: string;
  actor: string;
  task_id: string | null;
  task_key?: string | null;
  notification_id: string | null;
  trigger_type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  reason: string;
  exit_code: number | null;
  output: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Budget {
  actor: string;
  budget: number;
  period: "day" | "week" | "month";
  used: number;
  remaining: number | null;
  ratio: number | null;
  period_start: string;
}

export interface TaskFilter {
  project?: string;
  status?: TaskStatus[];
  assignee?: string | null;
  priority?: Priority[];
  type?: TaskType[];
  parent?: string;
  q?: string;
  include_closed?: boolean;
  limit?: number;
}

export interface Recommendation {
  task: Task;
  score: number;
  reasons: string[];
  over_budget: boolean;
}

export type HiveEvent = Activity;

// ---------------------------------------------------------------------------

const DEFAULT_GROUPS: Array<[string, string]> = [
  ["Now", "#579bfc"],
  ["Next", "#a25ddc"],
  ["Later", "#c4c4c4"],
];

const PROJECT_COLORS = ["#579bfc", "#00c875", "#a25ddc", "#fdab3d", "#e2445c", "#0086c0", "#ff642e", "#037f4c", "#bb3354", "#784bd1"];

type Row = Record<string, unknown>;

export class Service {
  readonly events = new EventEmitter();
  /** Events produced inside a transaction, emitted only once it commits. */
  private pendingEvents: Activity[] = [];
  /** Short-lived tokens minted for trigger runs (never persisted). */
  private ephemeral = new Map<string, { actor: string; expires: number }>();

  constructor(readonly db: DB) {
    this.events.setMaxListeners(200);
  }

  /** Run fn atomically; activity events are emitted after COMMIT and dropped on ROLLBACK. */
  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      const events = this.pendingEvents;
      this.pendingEvents = [];
      queueMicrotask(() => events.forEach((e) => this.events.emit("event", e)));
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.pendingEvents = [];
      throw err;
    }
  }

  private emit(event: Activity) {
    if (this.db.isTransaction) this.pendingEvents.push(event);
    else queueMicrotask(() => this.events.emit("event", event));
  }

  // -------------------------------------------------------------------------
  // settings
  // -------------------------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? parseJson<T>(row.value as string, fallback) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  settings() {
    return {
      loop_guard_limit: this.getSetting("loop_guard_limit", 6),
      default_lease_minutes: this.getSetting("default_lease_minutes", 60),
      owner: this.getSetting<string>("owner", "me"),
    };
  }

  // -------------------------------------------------------------------------
  // activity + events
  // -------------------------------------------------------------------------

  private log(actor: string | null, type: string, opts: { project_id?: string | null; task_id?: string | null; summary?: string; data?: Record<string, unknown> } = {}) {
    const created_at = now();
    const res = this.db
      .prepare("INSERT INTO activity (actor, type, project_id, task_id, summary, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(actor, type, opts.project_id ?? null, opts.task_id ?? null, opts.summary ?? "", JSON.stringify(opts.data ?? {}), created_at);
    const event: Activity = {
      id: Number(res.lastInsertRowid),
      actor,
      type,
      project_id: opts.project_id ?? null,
      task_id: opts.task_id ?? null,
      summary: opts.summary ?? "",
      data: opts.data ?? {},
      created_at,
    };
    this.emit(event);
    return event;
  }

  activity(opts: { project?: string; task?: string; actor?: string; limit?: number; after?: number } = {}): Activity[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.project) {
      where.push("a.project_id = ?");
      params.push(this.project(opts.project).id);
    }
    if (opts.task) {
      where.push("a.task_id = ?");
      params.push(this.taskRow(opts.task).id as string);
    }
    if (opts.actor) {
      where.push("a.actor = ?");
      params.push(opts.actor);
    }
    if (opts.after) {
      where.push("a.id > ?");
      params.push(opts.after);
    }
    const sql = `SELECT a.*, t.key AS task_key FROM activity a LEFT JOIN tasks t ON t.id = a.task_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ?`;
    params.push(Math.min(opts.limit ?? 50, 500));
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({ ...plain<Activity>(r), data: parseJson(r.data as string, {}) }));
  }

  // -------------------------------------------------------------------------
  // actors
  // -------------------------------------------------------------------------

  private mapActor(r: Row): Actor {
    const { token_hash, trigger_json, archived, ...rest } = plain<Row>(r);
    const { secret, ...trigger } = parseJson<TriggerConfig>(trigger_json as string, { type: "none", enabled: false });
    return {
      ...(rest as unknown as Actor),
      trigger: { ...trigger, has_secret: Boolean(secret) },
      has_token: Boolean(token_hash),
      archived: Boolean(archived),
    };
  }

  listActors(opts: { include_archived?: boolean } = {}): Actor[] {
    const rows = this.db
      .prepare(`SELECT * FROM actors ${opts.include_archived ? "" : "WHERE archived = 0"} ORDER BY kind DESC, name`)
      .all() as Row[];
    return rows.map((r) => this.mapActor(r));
  }

  /** Full trigger config including the webhook secret — for the runner only, never for API responses. */
  triggerConfig(id: string): TriggerConfig {
    const r = this.db.prepare("SELECT trigger_json FROM actors WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound(`Actor '${id}'`);
    return parseJson<TriggerConfig>(r.trigger_json as string, { type: "none", enabled: false });
  }

  findActor(id: string): Actor | null {
    const r = this.db.prepare("SELECT * FROM actors WHERE id = ?").get(id.toLowerCase()) as Row | undefined;
    return r ? this.mapActor(r) : null;
  }

  actor(id: string): Actor {
    const a = this.findActor(id);
    if (!a) throw notFound(`Actor '${id}'`);
    return a;
  }

  /** Mint a token that lets a woken agent call back for a limited time. */
  issueEphemeralToken(actorId: string, ttlMinutes: number): string {
    const token = newToken();
    this.ephemeral.set(token, { actor: this.actor(actorId).id, expires: Date.now() + ttlMinutes * 60_000 });
    for (const [k, v] of this.ephemeral) if (v.expires < Date.now()) this.ephemeral.delete(k);
    return token;
  }

  revokeEphemeralToken(token: string) {
    this.ephemeral.delete(token);
  }

  actorByToken(token: string): Actor | null {
    const eph = this.ephemeral.get(token);
    if (eph) {
      if (eph.expires > Date.now()) return this.findActor(eph.actor);
      this.ephemeral.delete(token);
    }
    const r = this.db.prepare("SELECT * FROM actors WHERE token_hash = ? AND archived = 0").get(hashToken(token)) as Row | undefined;
    return r ? this.mapActor(r) : null;
  }

  createActor(
    input: {
      id?: string;
      name: string;
      kind?: "human" | "agent";
      platform?: string;
      role?: string;
      color?: string;
      emoji?: string;
      description?: string;
      token_budget?: number;
      budget_period?: "day" | "week" | "month";
      trigger?: Partial<TriggerConfig>;
      issue_token?: boolean;
    },
    by: string | null = null,
  ): { actor: Actor; token?: string } {
    const id = slugify(input.id || input.name);
    if (!id) throw badRequest("Actor id/name must contain letters or digits");
    if (this.findActor(id)) throw conflict(`Actor '${id}' already exists`);
    const kind = input.kind ?? "agent";
    const token = input.issue_token ?? kind === "agent" ? newToken() : undefined;
    const ts = now();
    const trigger: TriggerConfig = { type: "none", enabled: false, ...input.trigger } as TriggerConfig;
    this.db
      .prepare(
        `INSERT INTO actors (id, name, kind, platform, role, color, emoji, description, token_budget, budget_period, trigger_json, token_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        kind,
        input.platform ?? (kind === "human" ? "human" : "other"),
        input.role ?? (kind === "human" ? "pm" : "developer"),
        input.color ?? PROJECT_COLORS[this.countRows("actors") % PROJECT_COLORS.length],
        input.emoji ?? (kind === "human" ? "🧑" : "🤖"),
        input.description ?? "",
        input.token_budget ?? 0,
        input.budget_period ?? "day",
        JSON.stringify(trigger),
        token ? hashToken(token) : null,
        ts,
        ts,
      );
    this.log(by, "actor.created", { summary: `${input.name} joined the desk`, data: { actor: id } });
    return { actor: this.actor(id), token };
  }

  updateActor(id: string, patch: Partial<Omit<Actor, "id" | "trigger" | "has_token" | "archived">> & { trigger?: Partial<TriggerConfig>; archived?: boolean }, by: string | null = null): Actor {
    const current = this.actor(id);
    const fields: Record<string, string | number | null> = {};
    for (const key of ["name", "platform", "role", "color", "emoji", "description", "token_budget", "budget_period", "status", "status_note"] as const) {
      if (patch[key] !== undefined) fields[key] = patch[key] as string | number;
    }
    if (patch.trigger) {
      const { has_secret: _ignored, ...incoming } = patch.trigger as TriggerConfig & { has_secret?: boolean };
      fields.trigger_json = JSON.stringify({ ...this.triggerConfig(current.id), ...incoming });
    }
    if (patch.archived !== undefined) fields.archived = patch.archived ? 1 : 0;
    if (Object.keys(fields).length === 0) return current;
    fields.updated_at = now();
    const sets = Object.keys(fields).map((k) => `${k} = ?`);
    this.db.prepare(`UPDATE actors SET ${sets.join(", ")} WHERE id = ?`).run(...Object.values(fields), current.id);
    this.log(by, "actor.updated", { summary: `${current.name} updated`, data: { actor: current.id, fields: Object.keys(fields) } });
    return this.actor(current.id);
  }

  rotateToken(id: string, by: string | null = null): string {
    const a = this.actor(id);
    const token = newToken();
    this.db.prepare("UPDATE actors SET token_hash = ?, updated_at = ? WHERE id = ?").run(hashToken(token), now(), a.id);
    this.log(by, "actor.token_rotated", { summary: `New access token for ${a.name}`, data: { actor: a.id } });
    return token;
  }

  /** Heartbeat: an agent says it is alive and what it is doing. */
  touchActor(id: string, status?: string, note?: string) {
    const a = this.actor(id);
    const ts = now();
    if (status !== undefined || note !== undefined) {
      const changed = (status !== undefined && status !== a.status) || (note !== undefined && note !== a.status_note);
      this.db
        .prepare("UPDATE actors SET status = ?, status_note = ?, last_seen_at = ?, updated_at = ? WHERE id = ?")
        .run(status ?? a.status, note ?? a.status_note, ts, ts, a.id);
      if (changed) this.log(a.id, "actor.status", { summary: `${a.name} is ${status ?? a.status}${note ? `: ${note}` : ""}`, data: { actor: a.id, status, note } });
    } else {
      this.db.prepare("UPDATE actors SET last_seen_at = ? WHERE id = ?").run(ts, a.id);
    }
  }

  // -------------------------------------------------------------------------
  // budgets + usage
  // -------------------------------------------------------------------------

  budget(actorId: string): Budget {
    const a = this.actor(actorId);
    const start = periodStart(a.budget_period);
    const row = this.db
      .prepare("SELECT COALESCE(SUM(tokens), 0) AS used FROM usage WHERE actor = ? AND created_at >= ?")
      .get(a.id, start.toISOString()) as Row;
    const used = Number(row.used);
    const budget = a.token_budget;
    return {
      actor: a.id,
      budget,
      period: a.budget_period,
      used,
      remaining: budget > 0 ? budget - used : null,
      ratio: budget > 0 ? Math.min(used / budget, 9.99) : null,
      period_start: start.toISOString(),
    };
  }

  recordUsage(actorId: string, tokens: number, opts: { task?: string; cost_usd?: number; note?: string } = {}) {
    if (!Number.isFinite(tokens) || tokens < 0) throw badRequest("tokens must be a non-negative number");
    const a = this.actor(actorId);
    const task = opts.task ? this.taskRow(opts.task) : null;
    this.tx(() => {
      this.db
        .prepare("INSERT INTO usage (id, actor, task_id, tokens, cost_usd, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(newId("u_"), a.id, (task?.id as string) ?? null, Math.round(tokens), opts.cost_usd ?? 0, opts.note ?? "", now());
      if (task) this.db.prepare("UPDATE tasks SET tokens_used = tokens_used + ? WHERE id = ?").run(Math.round(tokens), task.id as string);
      this.log(a.id, "usage.recorded", {
        project_id: (task?.project_id as string) ?? null,
        task_id: (task?.id as string) ?? null,
        summary: `${a.name} used ${tokens.toLocaleString("en-US")} tokens${task ? ` on ${task.key}` : ""}`,
        data: { tokens, cost_usd: opts.cost_usd ?? 0 },
      });
    });
    const b = this.budget(a.id);
    if (b.budget > 0 && b.used >= b.budget && b.used - tokens < b.budget) {
      this.notify(this.settings().owner, "budget", { sender: a.id, message: `${a.name} has used its ${b.period}ly token budget (${b.used.toLocaleString("en-US")}/${b.budget.toLocaleString("en-US")}).` });
    }
    return b;
  }

  usageSeries(days = 14) {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return (this.db
      .prepare("SELECT actor, substr(created_at, 1, 10) AS day, SUM(tokens) AS tokens FROM usage WHERE created_at >= ? GROUP BY actor, day ORDER BY day")
      .all(since) as Row[]).map((r) => plain<{ actor: string; day: string; tokens: number }>(r));
  }

  // -------------------------------------------------------------------------
  // projects + groups
  // -------------------------------------------------------------------------

  listProjects(opts: { include_archived?: boolean } = {}): Array<Project & { counts: Record<string, number>; open_tasks: number; total_tasks: number }> {
    const rows = this.db
      .prepare(`SELECT * FROM projects ${opts.include_archived ? "" : "WHERE status != 'archived'"} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, name`)
      .all() as Row[];
    const counts = this.db.prepare("SELECT project_id, status, COUNT(*) AS n FROM tasks GROUP BY project_id, status").all() as Row[];
    return rows.map((r) => {
      const p = plain<Project>(r);
      const c: Record<string, number> = {};
      let open = 0;
      let total = 0;
      for (const row of counts) {
        if (row.project_id !== p.id) continue;
        c[row.status as string] = Number(row.n);
        total += Number(row.n);
        if (OPEN_STATUSES.includes(row.status as TaskStatus)) open += Number(row.n);
      }
      return { ...p, counts: c, open_tasks: open, total_tasks: total };
    });
  }

  findProject(ref: string): Project | null {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ? OR key = ? COLLATE NOCASE").get(ref, ref) as Row | undefined;
    return r ? plain<Project>(r) : null;
  }

  project(ref: string): Project {
    const p = this.findProject(ref);
    if (!p) throw notFound(`Project '${ref}'`);
    return p;
  }

  createProject(
    input: { name: string; key?: string; description?: string; color?: string; repo_path?: string; repo_url?: string; owner?: string; brief?: string; priority?: Priority; groups?: string[] },
    by: string | null = null,
  ): Project {
    let key = (input.key || deriveKey(input.name)).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "PRJ";
    if (this.findProject(key)) {
      if (input.key) throw conflict(`Project key '${key}' is taken`);
      let i = 2;
      while (this.findProject(`${key}${i}`)) i++;
      key = `${key}${i}`;
    }
    const id = newId("p_");
    const ts = now();
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO projects (id, key, name, description, color, priority, repo_path, repo_url, owner, brief, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          key,
          input.name,
          input.description ?? "",
          input.color ?? PROJECT_COLORS[this.countRows("projects") % PROJECT_COLORS.length],
          input.priority ?? "medium",
          input.repo_path ?? "",
          input.repo_url ?? "",
          input.owner ?? by ?? null,
          input.brief ?? "",
          ts,
          ts,
        );
      const groups = input.groups?.length ? input.groups.map((g, i) => [g, DEFAULT_GROUPS[i % DEFAULT_GROUPS.length][1]] as [string, string]) : DEFAULT_GROUPS;
      groups.forEach(([name, color], i) => {
        this.db.prepare("INSERT INTO groups (id, project_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(newId("g_"), id, name, color, i, ts);
      });
      this.log(by, "project.created", { project_id: id, summary: `Project ${key} · ${input.name} created` });
    });
    return this.project(id);
  }

  updateProject(ref: string, patch: Partial<Omit<Project, "id" | "created_at" | "updated_at">>, by: string | null = null): Project {
    const p = this.project(ref);
    const fields: Record<string, string | null> = {};
    for (const k of ["name", "description", "color", "status", "priority", "repo_path", "repo_url", "owner", "brief"] as const) {
      if (patch[k] !== undefined) fields[k] = patch[k] as string | null;
    }
    if (patch.key !== undefined && patch.key.toUpperCase() !== p.key) {
      throw badRequest("Project keys are immutable (task keys depend on them)");
    }
    if (Object.keys(fields).length === 0) return p;
    fields.updated_at = now();
    this.db.prepare(`UPDATE projects SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(fields), p.id);
    const what = Object.keys(fields).filter((k) => k !== "updated_at");
    this.log(by, what.includes("brief") ? "project.brief_updated" : "project.updated", {
      project_id: p.id,
      summary: what.includes("brief") ? `Project brief of ${p.key} updated` : `Project ${p.key} updated (${what.join(", ")})`,
      data: { fields: what, status: fields.status },
    });
    return this.project(p.id);
  }

  deleteProject(ref: string, by: string | null = null) {
    const p = this.project(ref);
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    this.log(by, "project.deleted", { summary: `Project ${p.key} · ${p.name} deleted` });
  }

  groups(projectRef: string): Group[] {
    const p = this.project(projectRef);
    return (this.db.prepare("SELECT * FROM groups WHERE project_id = ? ORDER BY position").all(p.id) as Row[]).map((r) => ({
      ...plain<Group>(r),
      collapsed: Boolean(r.collapsed),
    }));
  }

  createGroup(projectRef: string, input: { name: string; color?: string }, by: string | null = null): Group {
    const p = this.project(projectRef);
    const max = this.db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM groups WHERE project_id = ?").get(p.id) as Row;
    const id = newId("g_");
    this.db
      .prepare("INSERT INTO groups (id, project_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, p.id, input.name, input.color ?? PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)], Number(max.m) + 1, now());
    this.log(by, "group.created", { project_id: p.id, summary: `Group "${input.name}" added to ${p.key}` });
    return this.groups(p.id).find((g) => g.id === id)!;
  }

  updateGroup(id: string, patch: { name?: string; color?: string; position?: number; collapsed?: boolean }, by: string | null = null): Group {
    const g = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Row | undefined;
    if (!g) throw notFound("Group");
    const fields: Record<string, string | number> = {};
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.color !== undefined) fields.color = patch.color;
    if (patch.position !== undefined) fields.position = patch.position;
    if (patch.collapsed !== undefined) fields.collapsed = patch.collapsed ? 1 : 0;
    if (Object.keys(fields).length) {
      this.db.prepare(`UPDATE groups SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(fields), id);
      this.log(by, "group.updated", { project_id: g.project_id as string, summary: `Group "${patch.name ?? g.name}" updated` });
    }
    return this.groups(g.project_id as string).find((x) => x.id === id)!;
  }

  deleteGroup(id: string, by: string | null = null) {
    const g = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Row | undefined;
    if (!g) throw notFound("Group");
    const remaining = this.db.prepare("SELECT id FROM groups WHERE project_id = ? AND id != ? ORDER BY position LIMIT 1").get(g.project_id as string, id) as Row | undefined;
    this.tx(() => {
      this.db.prepare("UPDATE tasks SET group_id = ? WHERE group_id = ?").run((remaining?.id as string) ?? null, id);
      this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
      this.log(by, "group.deleted", { project_id: g.project_id as string, summary: `Group "${g.name}" removed` });
    });
  }

  // -------------------------------------------------------------------------
  // tasks
  // -------------------------------------------------------------------------

  private taskRow(ref: string): Row {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ? OR key = ? COLLATE NOCASE").get(ref, ref) as Row | undefined;
    if (!r) throw notFound(`Task '${ref}'`);
    return r;
  }

  private hydrate(rows: Row[]): Task[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id as string);
    const marks = ids.map(() => "?").join(",");
    const links = this.db
      .prepare(
        `SELECT l.from_task, l.to_task, f.key AS from_key, f.status AS from_status, t.key AS to_key
         FROM task_links l JOIN tasks f ON f.id = l.from_task JOIN tasks t ON t.id = l.to_task
         WHERE l.type = 'blocks' AND (l.from_task IN (${marks}) OR l.to_task IN (${marks}))`,
      )
      .all(...ids, ...ids) as Row[];
    const subs = this.db
      .prepare(`SELECT parent_id, COUNT(*) AS n, SUM(CASE WHEN status IN ('done','canceled') THEN 1 ELSE 0 END) AS d FROM tasks WHERE parent_id IN (${marks}) GROUP BY parent_id`)
      .all(...ids) as Row[];
    const comments = this.db.prepare(`SELECT task_id, COUNT(*) AS n FROM comments WHERE task_id IN (${marks}) GROUP BY task_id`).all(...ids) as Row[];
    const projectKeys = new Map((this.db.prepare("SELECT id, key FROM projects").all() as Row[]).map((r) => [r.id as string, r.key as string]));
    const parentIds = rows.map((r) => r.parent_id).filter(Boolean) as string[];
    const parentKeys = new Map<string, string>();
    if (parentIds.length) {
      for (const r of this.db.prepare(`SELECT id, key FROM tasks WHERE id IN (${parentIds.map(() => "?").join(",")})`).all(...parentIds) as Row[]) {
        parentKeys.set(r.id as string, r.key as string);
      }
    }
    return rows.map((r) => {
      const t = plain<Row>(r);
      const sub = subs.find((s) => s.parent_id === t.id);
      return {
        ...(t as unknown as Task),
        project_key: projectKeys.get(t.project_id as string) ?? "",
        parent_key: t.parent_id ? (parentKeys.get(t.parent_id as string) ?? null) : null,
        tags: parseJson<string[]>(t.tags as string, []),
        blocked_by: links.filter((l) => l.to_task === t.id && !CLOSED_STATUSES.includes(l.from_status as TaskStatus)).map((l) => l.from_key as string),
        blocks: links.filter((l) => l.from_task === t.id).map((l) => l.to_key as string),
        subtask_count: Number(sub?.n ?? 0),
        subtasks_done: Number(sub?.d ?? 0),
        comment_count: Number(comments.find((c) => c.task_id === t.id)?.n ?? 0),
      };
    });
  }

  task(ref: string): Task {
    return this.hydrate([this.taskRow(ref)])[0];
  }

  listTasks(f: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.project) {
      where.push("project_id = ?");
      params.push(this.project(f.project).id);
    }
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => "?").join(",")})`);
      params.push(...f.status);
    } else if (!f.include_closed) {
      where.push("status NOT IN ('done','canceled')");
    }
    if (f.assignee !== undefined) {
      if (f.assignee === null || f.assignee === "" || f.assignee === "unassigned") where.push("assignee IS NULL");
      else {
        where.push("assignee = ?");
        params.push(f.assignee.toLowerCase());
      }
    }
    if (f.priority?.length) {
      where.push(`priority IN (${f.priority.map(() => "?").join(",")})`);
      params.push(...f.priority);
    }
    if (f.type?.length) {
      where.push(`type IN (${f.type.map(() => "?").join(",")})`);
      params.push(...f.type);
    }
    if (f.parent) {
      where.push("parent_id = ?");
      params.push(this.taskRow(f.parent).id as string);
    }
    if (f.q) {
      where.push("(title LIKE ? OR description LIKE ? OR key LIKE ?)");
      const like = `%${f.q}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY position, number LIMIT ?`;
    params.push(Math.min(f.limit ?? 500, 2000));
    return this.hydrate(this.db.prepare(sql).all(...params) as Row[]);
  }

  createTask(
    input: {
      project: string;
      title: string;
      description?: string;
      status?: TaskStatus;
      priority?: Priority;
      type?: TaskType;
      assignee?: string | null;
      group?: string | null;
      parent?: string | null;
      tags?: string[];
      due_at?: string | null;
      estimate_tokens?: number;
      blocked_by?: string[];
    },
    by: string | null = null,
  ): Task {
    const p = this.project(input.project);
    if (!input.title?.trim()) throw badRequest("title is required");
    if (input.status && !TASK_STATUSES.includes(input.status)) throw badRequest(`Unknown status '${input.status}'`);
    if (input.priority && !PRIORITIES.includes(input.priority)) throw badRequest(`Unknown priority '${input.priority}'`);
    const assignee = input.assignee ? this.actor(input.assignee).id : null;
    const parent = input.parent ? this.taskRow(input.parent) : null;
    let groupId: string | null = null;
    if (input.group) {
      const g = this.groups(p.id).find((x) => x.id === input.group || x.name.toLowerCase() === input.group!.toLowerCase());
      if (!g) throw notFound(`Group '${input.group}'`);
      groupId = g.id;
    } else if (parent?.group_id) {
      groupId = parent.group_id as string;
    } else {
      groupId = this.groups(p.id)[0]?.id ?? null;
    }
    const id = newId("t_");
    const ts = now();
    const status = input.status ?? "todo";
    const created = this.tx(() => {
      this.db.prepare("UPDATE projects SET task_seq = task_seq + 1, updated_at = ? WHERE id = ?").run(ts, p.id);
      const seq = Number((this.db.prepare("SELECT task_seq FROM projects WHERE id = ?").get(p.id) as Row).task_seq);
      const key = `${p.key}-${seq}`;
      const maxPos = this.db.prepare("SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE project_id = ?").get(p.id) as Row;
      this.db
        .prepare(
          `INSERT INTO tasks (id, project_id, group_id, number, key, title, description, status, priority, type, assignee, reporter, parent_id, tags, due_at,
            started_at, completed_at, estimate_tokens, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          p.id,
          groupId,
          seq,
          key,
          input.title.trim(),
          input.description ?? "",
          status,
          input.priority ?? "medium",
          input.type ?? "feature",
          assignee,
          by,
          (parent?.id as string) ?? null,
          JSON.stringify(input.tags ?? []),
          input.due_at ?? null,
          status === "in_progress" ? ts : null,
          CLOSED_STATUSES.includes(status) ? ts : null,
          input.estimate_tokens ?? 0,
          Number(maxPos.m) + 1,
          ts,
          ts,
        );
      for (const b of input.blocked_by ?? []) this.linkInternal(this.taskRow(b).id as string, id);
      this.log(by, "task.created", { project_id: p.id, task_id: id, summary: `${key} created: ${input.title.trim()}`, data: { assignee, status } });
      if (assignee && assignee !== by) this.notify(assignee, "assigned", { sender: by, task_id: id, project_id: p.id, message: input.title.trim() });
      this.notifyMentions(input.description ?? "", by, id, p.id, [assignee]);
      return key;
    });
    return this.task(created);
  }

  updateTask(
    ref: string,
    patch: {
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: Priority;
      type?: TaskType;
      assignee?: string | null;
      group?: string | null;
      parent?: string | null;
      tags?: string[];
      due_at?: string | null;
      estimate_tokens?: number;
      position?: number;
      project?: string;
    },
    by: string | null = null,
  ): Task {
    const t = this.taskRow(ref);
    this.assertNotLeasedByOther(t, by);
    const fields: Record<string, string | number | null> = {};
    const changes: string[] = [];
    const ts = now();
    if (patch.title !== undefined && patch.title.trim() && patch.title !== t.title) {
      fields.title = patch.title.trim();
      changes.push("title");
    }
    if (patch.description !== undefined && patch.description !== t.description) {
      fields.description = patch.description;
      changes.push("description");
    }
    if (patch.status !== undefined && patch.status !== t.status) {
      if (!TASK_STATUSES.includes(patch.status)) throw badRequest(`Unknown status '${patch.status}'`);
      fields.status = patch.status;
      if (patch.status === "in_progress" && !t.started_at) fields.started_at = ts;
      if (CLOSED_STATUSES.includes(patch.status)) {
        fields.completed_at = ts;
        fields.lease_holder = null;
        fields.lease_expires_at = null;
      } else if (t.completed_at) fields.completed_at = null;
      changes.push("status");
    }
    if (patch.priority !== undefined && patch.priority !== t.priority) {
      if (!PRIORITIES.includes(patch.priority)) throw badRequest(`Unknown priority '${patch.priority}'`);
      fields.priority = patch.priority;
      changes.push("priority");
    }
    if (patch.type !== undefined && patch.type !== t.type) {
      fields.type = patch.type;
      changes.push("type");
    }
    let newAssignee: string | null | undefined;
    if (patch.assignee !== undefined) {
      newAssignee = patch.assignee ? this.actor(patch.assignee).id : null;
      if (newAssignee !== t.assignee) {
        fields.assignee = newAssignee;
        changes.push("assignee");
      } else newAssignee = undefined;
    }
    if (patch.group !== undefined) {
      const g = patch.group ? this.groups(t.project_id as string).find((x) => x.id === patch.group || x.name.toLowerCase() === String(patch.group).toLowerCase()) : null;
      if (patch.group && !g) throw notFound(`Group '${patch.group}'`);
      if ((g?.id ?? null) !== t.group_id) {
        fields.group_id = g?.id ?? null;
        changes.push("group");
      }
    }
    if (patch.parent !== undefined) {
      const parent = patch.parent ? this.taskRow(patch.parent) : null;
      if (parent && parent.id === t.id) throw badRequest("A task cannot be its own parent");
      fields.parent_id = (parent?.id as string) ?? null;
      changes.push("parent");
    }
    if (patch.tags !== undefined) {
      fields.tags = JSON.stringify(patch.tags);
      changes.push("tags");
    }
    if (patch.due_at !== undefined && patch.due_at !== t.due_at) {
      fields.due_at = patch.due_at || null;
      changes.push("due");
    }
    if (patch.estimate_tokens !== undefined) {
      fields.estimate_tokens = Math.max(0, Math.round(patch.estimate_tokens));
      changes.push("estimate");
    }
    if (patch.position !== undefined) fields.position = patch.position;
    // A human touching status or owner is the "decision" the loop guard was waiting for.
    if ((fields.status !== undefined || changes.includes("assignee")) && Number(t.handoff_count) > 0 && by && this.isHuman(by)) fields.handoff_count = 0;
    if (Object.keys(fields).length === 0) return this.task(t.id as string);
    fields.updated_at = ts;

    this.tx(() => {
      this.db.prepare(`UPDATE tasks SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(fields), t.id as string);
      if (changes.length) {
        const parts: string[] = [];
        if (fields.status) parts.push(`status → ${fields.status}`);
        if (changes.includes("assignee")) parts.push(`assignee → ${newAssignee ?? "nobody"}`);
        if (fields.priority) parts.push(`priority → ${fields.priority}`);
        const rest = changes.filter((c) => !["status", "assignee", "priority"].includes(c));
        if (rest.length) parts.push(rest.join(", "));
        this.log(by, fields.status ? "task.status" : changes.includes("assignee") ? "task.assigned" : "task.updated", {
          project_id: t.project_id as string,
          task_id: t.id as string,
          summary: `${t.key} ${parts.join(" · ")}`,
          data: { changes, from: { status: t.status, assignee: t.assignee }, to: { status: fields.status, assignee: newAssignee } },
        });
      }
      if (newAssignee && newAssignee !== by) {
        this.notify(newAssignee, "assigned", { sender: by, task_id: t.id as string, project_id: t.project_id as string, message: String(fields.title ?? t.title) });
      }
      if (fields.status === "done" && t.reporter && t.reporter !== by) {
        this.notify(t.reporter as string, "completed", { sender: by, task_id: t.id as string, project_id: t.project_id as string, message: `${t.key} is done: ${t.title}` });
      }
      if (fields.description !== undefined) this.notifyMentions(fields.description as string, by, t.id as string, t.project_id as string, [newAssignee ?? null]);
    });
    return this.task(t.id as string);
  }

  deleteTask(ref: string, by: string | null = null) {
    const t = this.taskRow(ref);
    this.assertNotLeasedByOther(t, by);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id as string);
    this.log(by, "task.deleted", { project_id: t.project_id as string, summary: `${t.key} deleted: ${t.title}` });
  }

  private linkInternal(from: string, to: string) {
    if (from === to) throw badRequest("A task cannot block itself");
    this.db.prepare("INSERT OR IGNORE INTO task_links (from_task, to_task, type) VALUES (?, ?, 'blocks')").run(from, to);
  }

  /** `blocker` must be finished before `blocked` can start. */
  link(blocker: string, blocked: string, by: string | null = null) {
    const a = this.taskRow(blocker);
    const b = this.taskRow(blocked);
    this.linkInternal(a.id as string, b.id as string);
    this.log(by, "task.linked", { project_id: b.project_id as string, task_id: b.id as string, summary: `${a.key} blocks ${b.key}` });
    return this.task(b.id as string);
  }

  unlink(blocker: string, blocked: string, by: string | null = null) {
    const a = this.taskRow(blocker);
    const b = this.taskRow(blocked);
    this.db.prepare("DELETE FROM task_links WHERE from_task = ? AND to_task = ?").run(a.id as string, b.id as string);
    this.log(by, "task.unlinked", { project_id: b.project_id as string, task_id: b.id as string, summary: `${a.key} no longer blocks ${b.key}` });
    return this.task(b.id as string);
  }

  // -------------------------------------------------------------------------
  // agent workflow: claim, release, complete, handoff
  // -------------------------------------------------------------------------

  private isHuman(actorId: string | null): boolean {
    return actorId ? this.findActor(actorId)?.kind === "human" : true;
  }

  /** Agents may not modify a task another agent is actively working on; humans can always override. */
  private assertNotLeasedByOther(t: Row, actorId: string | null) {
    if (this.isHuman(actorId)) return;
    const holder = t.lease_holder as string | null;
    const expires = t.lease_expires_at as string | null;
    if (holder && holder !== actorId && expires && expires > now()) {
      throw conflict(`${t.key} is claimed by ${holder} until ${expires}`);
    }
  }

  claim(ref: string, actorId: string, minutes?: number): Task {
    const a = this.actor(actorId);
    const lease = minutes ?? this.settings().default_lease_minutes;
    return this.tx(() => {
      const t = this.taskRow(ref);
      const holder = t.lease_holder as string | null;
      const expires = t.lease_expires_at as string | null;
      if (holder && holder !== a.id && expires && expires > now()) {
        throw conflict(`${t.key} is claimed by ${holder} until ${expires}`);
      }
      if (CLOSED_STATUSES.includes(t.status as TaskStatus)) throw conflict(`${t.key} is already ${t.status}`);
      const blockers = this.task(t.id as string).blocked_by;
      if (blockers.length) throw conflict(`${t.key} is blocked by ${blockers.join(", ")}`);
      const ts = now();
      const until = new Date(Date.now() + lease * 60_000).toISOString();
      const status = ["backlog", "todo", "blocked"].includes(t.status as string) ? "in_progress" : (t.status as string);
      this.db
        .prepare(
          "UPDATE tasks SET lease_holder = ?, lease_expires_at = ?, assignee = COALESCE(assignee, ?), status = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
        )
        .run(a.id, until, a.id, status, ts, ts, t.id as string);
      if (holder !== a.id) {
        this.log(a.id, "task.claimed", { project_id: t.project_id as string, task_id: t.id as string, summary: `${a.name} picked up ${t.key}`, data: { until } });
      }
      this.db.prepare("UPDATE actors SET status = 'working', status_note = ?, last_seen_at = ? WHERE id = ?").run(`${t.key}: ${truncate(t.title as string, 60)}`, ts, a.id);
      return this.task(t.id as string);
    });
  }

  release(ref: string, actorId: string, note?: string): Task {
    const t = this.taskRow(ref);
    const a = this.actor(actorId);
    if (t.lease_holder && t.lease_holder !== a.id) throw conflict(`${t.key} is claimed by ${t.lease_holder}`);
    this.tx(() => {
      this.db.prepare("UPDATE tasks SET lease_holder = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(now(), t.id as string);
      if (note) this.addCommentInternal(t, a.id, note, "comment");
      this.log(a.id, "task.released", { project_id: t.project_id as string, task_id: t.id as string, summary: `${a.name} let go of ${t.key}` });
    });
    return this.task(t.id as string);
  }

  complete(
    ref: string,
    actorId: string,
    input: { summary: string; tokens_used?: number; status?: "done" | "review" | "testing"; next_assignee?: string },
  ): Task {
    const a = this.actor(actorId);
    const t = this.taskRow(ref);
    this.assertNotLeasedByOther(t, a.id);
    if (CLOSED_STATUSES.includes(t.status as TaskStatus)) throw conflict(`${t.key} is already ${t.status}`);
    const status = input.status ?? "done";
    this.tx(() => {
      this.addCommentInternal(t, a.id, input.summary, "report");
      if (input.next_assignee && status !== "done") {
        // Passing work on for review/testing is a handoff too, so it counts toward the loop guard.
        const target = this.actor(input.next_assignee);
        const { count, tripped } = this.loopGuard(t, a.id);
        this.db
          .prepare("UPDATE tasks SET status = ?, assignee = ?, handoff_count = ?, updated_at = ? WHERE id = ?")
          .run(tripped ? "blocked" : status, tripped ? (t.assignee as string | null) : target.id, count, now(), t.id as string);
        this.log(a.id, "task.status", {
          project_id: t.project_id as string,
          task_id: t.id as string,
          summary: `${t.key} status → ${tripped ? "blocked" : status} · assignee → ${tripped ? t.assignee : target.id}`,
          data: { changes: ["status", "assignee"], loop_guard: tripped },
        });
        if (tripped) this.tripLoopGuard(t, a.id, count);
        else this.notify(target.id, "review_request", { sender: a.id, task_id: t.id as string, project_id: t.project_id as string, message: `${t.key} is ready for ${status}: ${t.title}` });
      } else {
        this.updateTask(t.id as string, { status }, a.id);
      }
      this.db.prepare("UPDATE tasks SET lease_holder = NULL, lease_expires_at = NULL WHERE id = ?").run(t.id as string);
      this.db.prepare("UPDATE actors SET status = 'idle', status_note = '', last_seen_at = ? WHERE id = ?").run(now(), a.id);
    });
    if (input.tokens_used) this.recordUsage(a.id, input.tokens_used, { task: t.id as string, note: "task completion" });
    return this.task(t.id as string);
  }

  handoff(
    ref: string,
    fromId: string,
    input: {
      to: string;
      message: string;
      status?: TaskStatus;
      tokens_used?: number;
      subtasks?: Array<{ title: string; description?: string; priority?: Priority; type?: TaskType }>;
    },
  ): { task: Task; subtasks: Task[]; loop_guard: boolean } {
    const from = this.actor(fromId);
    const to = this.actor(input.to);
    const t = this.taskRow(ref);
    this.assertNotLeasedByOther(t, from.id);
    const result = this.tx(() => {
      const { count, tripped } = this.loopGuard(t, from.id);
      const status = tripped ? "blocked" : (input.status ?? (to.role === "tester" ? "testing" : to.role === "reviewer" ? "review" : "todo"));
      this.db
        .prepare("UPDATE tasks SET handoff_count = ?, lease_holder = NULL, lease_expires_at = NULL WHERE id = ?")
        .run(count, t.id as string);
      this.addCommentInternal(t, from.id, `**Handoff → @${to.id}**\n\n${input.message}`, "handoff", false);
      const subtasks: Task[] = [];
      for (const s of input.subtasks ?? []) {
        subtasks.push(
          this.createTask(
            { project: t.project_id as string, parent: t.id as string, title: s.title, description: s.description, priority: s.priority ?? (t.priority as Priority), type: s.type ?? "bug", assignee: to.id },
            from.id,
          ),
        );
      }
      // Avoid a duplicate "assigned" ping — the handoff notification below carries the context.
      this.db.prepare("UPDATE tasks SET assignee = ?, status = ?, updated_at = ?, completed_at = NULL WHERE id = ?").run(tripped ? t.assignee as string | null : to.id, status, now(), t.id as string);
      this.log(from.id, "task.handoff", {
        project_id: t.project_id as string,
        task_id: t.id as string,
        summary: `${from.name} handed ${t.key} to ${to.name}${subtasks.length ? ` with ${subtasks.length} sub-task(s)` : ""}`,
        data: { from: from.id, to: to.id, status, subtasks: subtasks.map((s) => s.key), loop_guard: tripped },
      });
      if (tripped) {
        this.tripLoopGuard(t, from.id, count);
      } else {
        this.notify(to.id, "handoff", { sender: from.id, task_id: t.id as string, project_id: t.project_id as string, message: truncate(input.message, 400) });
      }
      this.db.prepare("UPDATE actors SET status = 'idle', status_note = '', last_seen_at = ? WHERE id = ?").run(now(), from.id);
      return { subtasks, loop_guard: tripped };
    });
    if (input.tokens_used) this.recordUsage(from.id, input.tokens_used, { task: t.id as string, note: "handoff" });
    return { task: this.task(t.id as string), ...result };
  }

  /** Next handoff count for a task; humans reset it (their handoff is the decision the guard waits for). */
  private loopGuard(t: Row, actorId: string): { count: number; tripped: boolean } {
    if (this.isHuman(actorId)) return { count: 0, tripped: false };
    const count = Number(t.handoff_count) + 1;
    return { count, tripped: count > this.settings().loop_guard_limit };
  }

  private tripLoopGuard(t: Row, sender: string, count: number) {
    this.notify(this.settings().owner, "loop_guard", {
      sender,
      task_id: t.id as string,
      project_id: t.project_id as string,
      message: `${t.key} bounced between agents ${count} times — paused for a human decision.`,
    });
  }

  /** Release leases whose holder went silent. Returns the keys that were freed. */
  expireLeases(): string[] {
    const rows = this.db.prepare("SELECT id, key, project_id, lease_holder FROM tasks WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ?").all(now()) as Row[];
    for (const r of rows) {
      this.db.prepare("UPDATE tasks SET lease_holder = NULL, lease_expires_at = NULL WHERE id = ?").run(r.id as string);
      this.log(null, "task.lease_expired", { project_id: r.project_id as string, task_id: r.id as string, summary: `Lease on ${r.key} held by ${r.lease_holder} expired` });
    }
    return rows.map((r) => r.key as string);
  }

  // -------------------------------------------------------------------------
  // comments
  // -------------------------------------------------------------------------

  comments(ref: string): Comment[] {
    const t = this.taskRow(ref);
    return (this.db.prepare("SELECT * FROM comments WHERE task_id = ? ORDER BY created_at").all(t.id as string) as Row[]).map((r) => plain<Comment>(r));
  }

  addComment(ref: string, authorId: string | null, body: string, kind: Comment["kind"] = "comment"): Comment {
    if (!body.trim()) throw badRequest("Comment body is empty");
    const t = this.taskRow(ref);
    return this.tx(() => this.addCommentInternal(t, authorId, body, kind));
  }

  private addCommentInternal(t: Row, authorId: string | null, body: string, kind: Comment["kind"], mentions = true): Comment {
    const id = newId("c_");
    const ts = now();
    this.db.prepare("INSERT INTO comments (id, task_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, t.id as string, authorId, kind, body, ts);
    this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, t.id as string);
    if (kind !== "handoff") {
      this.log(authorId, kind === "report" ? "task.report" : "task.comment", {
        project_id: t.project_id as string,
        task_id: t.id as string,
        summary: `${kind === "report" ? "Report" : "Update"} on ${t.key}: ${truncate(body.replace(/\s+/g, " "), 140)}`,
        data: { comment: id },
      });
    }
    if (mentions) {
      const mentioned = this.notifyMentions(body, authorId, t.id as string, t.project_id as string, []);
      // Let the assignee know about human updates even without an explicit mention.
      if (kind === "comment" && t.assignee && t.assignee !== authorId && !mentioned.includes(t.assignee as string)) {
        const author = authorId ? this.findActor(authorId) : null;
        if (author?.kind === "human") {
          this.notify(t.assignee as string, "comment", { sender: authorId, task_id: t.id as string, project_id: t.project_id as string, message: truncate(body, 400) });
        }
      }
    }
    return plain<Comment>(this.db.prepare("SELECT * FROM comments WHERE id = ?").get(id));
  }

  private notifyMentions(text: string, sender: string | null, taskId: string | null, projectId: string | null, skip: (string | null)[]): string[] {
    const sent: string[] = [];
    for (const id of extractMentions(text)) {
      if (id === sender || skip.includes(id)) continue;
      if (!this.findActor(id)) continue;
      this.notify(id, "mentioned", { sender, task_id: taskId, project_id: projectId, message: truncate(text, 400) });
      sent.push(id);
    }
    return sent;
  }

  // -------------------------------------------------------------------------
  // notifications (inbox)
  // -------------------------------------------------------------------------

  notify(recipient: string, type: NotificationType, opts: { sender?: string | null; task_id?: string | null; project_id?: string | null; message?: string }) {
    const r = this.findActor(recipient);
    if (!r) return null;
    const id = newId("n_");
    const ts = now();
    this.db
      .prepare("INSERT INTO notifications (id, recipient, sender, type, task_id, project_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, r.id, opts.sender ?? null, type, opts.task_id ?? null, opts.project_id ?? null, opts.message ?? "", ts);
    const event = this.log(opts.sender ?? null, "notification", {
      project_id: opts.project_id ?? null,
      task_id: opts.task_id ?? null,
      summary: `${type} → ${r.id}`,
      data: { notification: id, recipient: r.id, type, wakes: WAKING_NOTIFICATIONS.includes(type) && r.kind === "agent" },
    });
    return { id, event };
  }

  inbox(actorId: string, opts: { unread_only?: boolean; limit?: number } = {}): Notification[] {
    const a = this.actor(actorId);
    return (this.db
      .prepare(
        `SELECT n.*, t.key AS task_key, t.title AS task_title FROM notifications n LEFT JOIN tasks t ON t.id = n.task_id
         WHERE n.recipient = ? ${opts.unread_only ? "AND n.read_at IS NULL" : ""} ORDER BY n.created_at DESC LIMIT ?`,
      )
      .all(a.id, Math.min(opts.limit ?? 50, 500)) as Row[]).map((r) => plain<Notification>(r));
  }

  notification(id: string): Notification {
    const r = this.db
      .prepare("SELECT n.*, t.key AS task_key, t.title AS task_title FROM notifications n LEFT JOIN tasks t ON t.id = n.task_id WHERE n.id = ?")
      .get(id) as Row | undefined;
    if (!r) throw notFound("Notification");
    return plain<Notification>(r);
  }

  unreadCount(actorId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE recipient = ? AND read_at IS NULL").get(actorId) as Row).n);
  }

  markRead(actorId: string, ids: string[] | "all") {
    const ts = now();
    if (ids === "all") this.db.prepare("UPDATE notifications SET read_at = ? WHERE recipient = ? AND read_at IS NULL").run(ts, actorId);
    else for (const id of ids) this.db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND recipient = ?").run(ts, id, actorId);
    this.emit({ id: 0, actor: actorId, type: "inbox.read", project_id: null, task_id: null, summary: "", data: { recipient: actorId }, created_at: ts });
  }

  // -------------------------------------------------------------------------
  // decisions
  // -------------------------------------------------------------------------

  private mapDecision(r: Row): Decision {
    const d = plain<Decision>(r);
    return { ...d, ref: `${d.project_key ?? "D"}-D${d.number}` };
  }

  decisions(opts: { project?: string; task?: string; q?: string; limit?: number } = {}): Decision[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.project) {
      where.push("d.project_id = ?");
      params.push(this.project(opts.project).id);
    }
    if (opts.task) {
      where.push("d.task_id = ?");
      params.push(this.taskRow(opts.task).id as string);
    }
    if (opts.q) {
      where.push("(d.title LIKE ? OR d.decision LIKE ? OR d.rationale LIKE ?)");
      params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
    }
    params.push(Math.min(opts.limit ?? 100, 1000));
    return (this.db
      .prepare(
        `SELECT d.*, p.key AS project_key, t.key AS task_key FROM decisions d
         LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN tasks t ON t.id = d.task_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY d.created_at DESC LIMIT ?`,
      )
      .all(...params) as Row[]).map((r) => this.mapDecision(r));
  }

  decision(id: string): Decision {
    const r = this.db
      .prepare("SELECT d.*, p.key AS project_key, t.key AS task_key FROM decisions d LEFT JOIN projects p ON p.id = d.project_id LEFT JOIN tasks t ON t.id = d.task_id WHERE d.id = ?")
      .get(id) as Row | undefined;
    if (!r) throw notFound("Decision");
    return this.mapDecision(r);
  }

  logDecision(
    input: { project?: string | null; task?: string | null; title: string; decision: string; context?: string; rationale?: string; alternatives?: string; status?: DecisionStatus },
    by: string | null = null,
  ): Decision {
    if (!input.title?.trim() || !input.decision?.trim()) throw badRequest("title and decision are required");
    const task = input.task ? this.taskRow(input.task) : null;
    const project = input.project ? this.project(input.project) : task ? this.project(task.project_id as string) : null;
    const id = newId("d_");
    const ts = now();
    this.tx(() => {
      const n = Number(
        (this.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE ${project ? "project_id = ?" : "project_id IS NULL"}`).get(...(project ? [project.id] : [])) as Row).n,
      ) + 1;
      this.db
        .prepare(
          `INSERT INTO decisions (id, project_id, task_id, number, title, context, decision, rationale, alternatives, status, author, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, project?.id ?? null, (task?.id as string) ?? null, n, input.title.trim(), input.context ?? "", input.decision, input.rationale ?? "", input.alternatives ?? "", input.status ?? "accepted", by, ts, ts);
      this.log(by, "decision.logged", {
        project_id: project?.id ?? null,
        task_id: (task?.id as string) ?? null,
        summary: `Decision${project ? ` in ${project.key}` : ""}: ${input.title.trim()}`,
        data: { decision: id, status: input.status ?? "accepted" },
      });
      this.notifyMentions(`${input.context ?? ""}\n${input.decision}\n${input.rationale ?? ""}`, by, (task?.id as string) ?? null, project?.id ?? null, []);
    });
    return this.decision(id);
  }

  updateDecision(id: string, patch: Partial<Pick<Decision, "title" | "context" | "decision" | "rationale" | "alternatives" | "status">>, by: string | null = null): Decision {
    const d = this.decision(id);
    const fields: Record<string, string> = {};
    for (const k of ["title", "context", "decision", "rationale", "alternatives", "status"] as const) if (patch[k] !== undefined) fields[k] = patch[k]!;
    if (!Object.keys(fields).length) return d;
    fields.updated_at = now();
    this.db.prepare(`UPDATE decisions SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(fields), id);
    this.log(by, "decision.updated", { project_id: d.project_id, task_id: d.task_id, summary: `Decision ${d.ref} ${fields.status ? `marked ${fields.status}` : "edited"}` });
    return this.decision(id);
  }

  // -------------------------------------------------------------------------
  // runs (trigger executions)
  // -------------------------------------------------------------------------

  createRun(input: { actor: string; task_id?: string | null; notification_id?: string | null; trigger_type: string; status?: Run["status"]; reason?: string }): Run {
    const id = newId("r_");
    const ts = now();
    this.db
      .prepare("INSERT INTO runs (id, actor, task_id, notification_id, trigger_type, status, reason, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.actor, input.task_id ?? null, input.notification_id ?? null, input.trigger_type, input.status ?? "running", input.reason ?? "", input.status === "skipped" ? null : ts, ts);
    const run = this.run(id);
    const task = run.task_id ? this.findTaskLite(run.task_id) : null;
    this.log(null, input.status === "skipped" ? "run.skipped" : "run.started", {
      project_id: task?.project_id ?? null,
      task_id: run.task_id,
      summary: input.status === "skipped" ? `Did not wake ${input.actor}: ${input.reason}` : `Woke ${input.actor} via ${input.trigger_type}${task ? ` for ${task.key}` : ""}`,
      data: { run: id, actor: input.actor },
    });
    return run;
  }

  finishRun(id: string, input: { status: "succeeded" | "failed"; exit_code?: number | null; output?: string; reason?: string }): Run {
    this.db
      .prepare("UPDATE runs SET status = ?, exit_code = ?, output = ?, reason = COALESCE(NULLIF(?, ''), reason), finished_at = ? WHERE id = ?")
      .run(input.status, input.exit_code ?? null, (input.output ?? "").slice(-20000), input.reason ?? "", now(), id);
    const run = this.run(id);
    const task = run.task_id ? this.findTaskLite(run.task_id) : null;
    this.log(null, "run.finished", {
      project_id: task?.project_id ?? null,
      task_id: run.task_id,
      summary: `${run.actor} run ${input.status}${input.exit_code !== undefined && input.exit_code !== null ? ` (exit ${input.exit_code})` : ""}`,
      data: { run: id, actor: run.actor, status: input.status },
    });
    return run;
  }

  run(id: string): Run {
    const r = this.db.prepare("SELECT r.*, t.key AS task_key FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("Run");
    return plain<Run>(r);
  }

  runs(opts: { actor?: string; limit?: number; status?: Run["status"] } = {}): Run[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.actor) {
      where.push("r.actor = ?");
      params.push(opts.actor);
    }
    if (opts.status) {
      where.push("r.status = ?");
      params.push(opts.status);
    }
    params.push(Math.min(opts.limit ?? 50, 500));
    return (this.db
      .prepare(`SELECT r.*, t.key AS task_key FROM runs r LEFT JOIN tasks t ON t.id = r.task_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.created_at DESC LIMIT ?`)
      .all(...params) as Row[]).map((r) => plain<Run>(r));
  }

  recentRunCount(actorId: string, taskId: string | null, sinceMinutes: number): number {
    const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs WHERE actor = ? AND status != 'skipped' AND created_at >= ? ${taskId ? "AND task_id = ?" : ""}`)
      .get(...([actorId, since, ...(taskId ? [taskId] : [])] as string[])) as Row;
    return Number(row.n);
  }

  private findTaskLite(id: string): { key: string; project_id: string } | null {
    const r = this.db.prepare("SELECT key, project_id FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return r ? (plain(r) as { key: string; project_id: string }) : null;
  }

  // -------------------------------------------------------------------------
  // prioritisation
  // -------------------------------------------------------------------------

  /** Rank the work an actor should do next, weighing priority, deadlines, blockers and its token budget. */
  recommend(actorId: string, limit = 5): Recommendation[] {
    const a = this.actor(actorId);
    const b = this.budget(a.id);
    const roleTypes: Record<string, TaskType[]> = {
      developer: ["feature", "bug", "chore"],
      tester: ["test", "bug"],
      reviewer: ["review"],
      architect: ["research", "feature", "review"],
      researcher: ["research", "docs"],
      devops: ["chore"],
      designer: ["feature"],
      pm: [],
      generalist: ["feature", "bug", "chore", "test", "review", "research", "docs"],
    };
    const activeProjects = new Set(this.listProjects().filter((p) => p.status === "active").map((p) => p.id));
    const projectPriority = new Map(this.listProjects().map((p) => [p.id, p.priority as Priority]));
    const mine = this.listTasks({ assignee: a.id, status: ["todo", "in_progress", "review", "testing", "backlog"] });
    const types = roleTypes[a.role] ?? [];
    const unassigned = types.length ? this.listTasks({ assignee: null, status: ["todo"], type: types }) : [];
    const nowMs = Date.now();
    const scored: Recommendation[] = [];
    for (const t of [...mine, ...unassigned]) {
      if (!activeProjects.has(t.project_id)) continue;
      if (t.blocked_by.length) continue;
      if (t.lease_holder && t.lease_holder !== a.id && t.lease_expires_at && t.lease_expires_at > new Date().toISOString()) continue;
      const reasons: string[] = [];
      let score = PRIORITY_WEIGHT[t.priority];
      reasons.push(`${t.priority} priority`);
      const pp = projectPriority.get(t.project_id) ?? "medium";
      if (pp === "critical" || pp === "high") {
        score += pp === "critical" ? 25 : 12;
        reasons.push(`${pp}-priority project`);
      }
      if (t.assignee === a.id) {
        score += 20;
        reasons.push("assigned to you");
      } else reasons.push(`unassigned ${t.type} matching your role`);
      if (t.status === "in_progress") {
        score += 80;
        reasons.push("already in progress — finish what you started");
      }
      if (t.status === "review" || t.status === "testing") {
        score += 40;
        reasons.push(`waiting on your ${t.status}`);
      }
      if (t.status === "backlog") score -= 40;
      if (t.due_at) {
        const hours = (Date.parse(t.due_at) - nowMs) / 3_600_000;
        if (hours < 0) {
          score += 50;
          reasons.push("overdue");
        } else if (hours < 24) {
          score += 30;
          reasons.push("due within 24h");
        } else if (hours < 72) {
          score += 15;
          reasons.push("due within 3 days");
        }
      }
      if (t.blocks.length) {
        score += 10 * t.blocks.length;
        reasons.push(`unblocks ${t.blocks.join(", ")}`);
      }
      const ageDays = (nowMs - Date.parse(t.created_at)) / 86_400_000;
      score += Math.min(Math.floor(ageDays), 14);
      let overBudget = false;
      if (b.remaining !== null) {
        if (b.remaining <= 0) {
          overBudget = true;
          if (t.priority !== "critical") continue;
          reasons.push("budget exhausted — critical only");
        } else if (t.estimate_tokens > b.remaining) {
          overBudget = true;
          score -= 80;
          reasons.push(`estimate ${t.estimate_tokens.toLocaleString("en-US")} > remaining budget ${b.remaining.toLocaleString("en-US")}`);
        } else if (b.ratio !== null && b.ratio > 0.8 && t.priority === "low") {
          score -= 40;
          reasons.push("budget running low — low priority deferred");
        }
      }
      scored.push({ task: t, score, reasons, over_budget: overBudget });
    }
    return scored.sort((x, y) => y.score - x.score).slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // overview + briefing
  // -------------------------------------------------------------------------

  overview() {
    const projects = this.listProjects();
    const actors = this.listActors();
    const budgets = actors.filter((a) => a.kind === "agent").map((a) => ({ ...this.budget(a.id), name: a.name }));
    const totals = this.db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as Row[];
    const byStatus: Record<string, number> = {};
    for (const r of totals) byStatus[r.status as string] = Number(r.n);
    const overdue = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE due_at IS NOT NULL AND due_at < ? AND status NOT IN ('done','canceled')").get(now()) as Row).n,
    );
    const doneThisWeek = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE completed_at >= ? AND status = 'done'").get(periodStart("week").toISOString()) as Row).n,
    );
    const inProgress = this.listTasks({ status: ["in_progress", "review", "testing"], limit: 50 });
    return {
      projects,
      actors,
      budgets,
      by_status: byStatus,
      overdue,
      done_this_week: doneThisWeek,
      in_progress: inProgress,
      recent_decisions: this.decisions({ limit: 8 }),
      activity: this.activity({ limit: 30 }).filter((a) => a.type !== "notification"),
      usage: this.usageSeries(14),
    };
  }

  /**
   * The "context pack" an agent reads at the start of a session: who it is, its budget, its inbox,
   * what to do next and a compact picture of the whole portfolio. Designed to be cheap in tokens.
   */
  briefing(actorId: string, opts: { project?: string } = {}) {
    const a = this.actor(actorId);
    this.touchActor(a.id);
    const budget = this.budget(a.id);
    const inbox = this.inbox(a.id, { unread_only: true, limit: 15 });
    const myTasks = this.listTasks({ assignee: a.id, limit: 30 });
    const next = this.recommend(a.id, 5);
    const projects = this.listProjects()
      .filter((p) => p.status === "active" || p.status === "paused")
      .filter((p) => !opts.project || p.key === opts.project.toUpperCase() || p.id === opts.project);
    const decisions = this.decisions({ project: opts.project, limit: 8 });
    const teammates = this.listActors().filter((x) => x.id !== a.id);
    return { me: a, budget, inbox, my_tasks: myTasks, next, projects, decisions, teammates, focus: opts.project ? this.project(opts.project) : null };
  }

  private countRows(table: "actors" | "projects"): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
  }
}
