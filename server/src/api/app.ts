import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import type { Service, Actor, Activity } from "../service.js";
import {
  DECISION_STATUSES,
  PLATFORMS,
  PRIORITIES,
  PROJECT_STATUSES,
  ROLES,
  TASK_STATUSES,
  TASK_TYPES,
  TRIGGER_TYPES,
  NOTIFICATION_TYPES,
  SwarmError,
  forbidden,
  badRequest,
  type TaskStatus,
  type Priority,
  type TaskType,
} from "../domain.js";
import { connectSnippets } from "../connect.js";
import { renderBoard, renderBriefing, renderDecisions, renderInbox, renderPortfolio, renderTask, renderTaskList } from "../render.js";

export interface AppConfig {
  /** If set, required as Bearer token for human/admin access (the web UI). */
  adminToken?: string;
  /** Without an admin token, treat loopback requests as the owner. */
  trustLocal: boolean;
  /** Directory with the built web app. */
  webDir?: string;
  /** Mounted by the caller: handles /mcp for an authenticated actor. */
  mcp?: (req: Request, actor: Actor) => Promise<Response>;
  version: string;
  /** URL agents use to reach the desk (shown in setup snippets). */
  deskUrl?: string;
}

type Env = {
  Bindings: { incoming?: { socket?: { remoteAddress?: string } }; internalActor?: string };
  Variables: { actor: Actor };
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d+)?$/i;

const csv = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

const triggerSchema = z
  .object({
    type: z.enum(TRIGGER_TYPES),
    enabled: z.boolean(),
    on: z.array(z.enum(NOTIFICATION_TYPES)).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    secret: z.string().optional(),
    timeout_minutes: z.number().positive().max(24 * 60).optional(),
    respect_budget: z.boolean().optional(),
  })
  .partial();

const actorCreate = z.object({
  id: z.string().max(40).optional(),
  name: z.string().min(1).max(80),
  kind: z.enum(["human", "agent"]).optional(),
  platform: z.enum(PLATFORMS).optional(),
  role: z.enum(ROLES).optional(),
  color: z.string().max(20).optional(),
  emoji: z.string().max(8).optional(),
  description: z.string().max(4000).optional(),
  token_budget: z.number().int().min(0).optional(),
  budget_period: z.enum(["day", "week", "month"]).optional(),
  trigger: triggerSchema.optional(),
});
const actorPatch = actorCreate.omit({ id: true, kind: true }).partial().extend({
  status: z.string().max(40).optional(),
  status_note: z.string().max(200).optional(),
  archived: z.boolean().optional(),
});

const projectCreate = z.object({
  name: z.string().min(1).max(120),
  key: z.string().max(8).optional(),
  description: z.string().max(4000).optional(),
  color: z.string().max(20).optional(),
  repo_path: z.string().max(500).optional(),
  repo_url: z.string().max(500).optional(),
  owner: z.string().optional(),
  brief: z.string().max(50_000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  groups: z.array(z.string().min(1).max(60)).max(20).optional(),
});
const projectPatch = projectCreate.omit({ groups: true }).partial().extend({ status: z.enum(PROJECT_STATUSES).optional(), owner: z.string().nullable().optional() });

const taskCreate = z.object({
  project: z.string(),
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  assignee: z.string().nullable().optional(),
  group: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  due_at: z.string().nullable().optional(),
  estimate_tokens: z.number().int().min(0).optional(),
  blocked_by: z.array(z.string()).optional(),
});
const taskPatch = taskCreate.omit({ project: true, blocked_by: true }).partial().extend({ position: z.number().optional() });

const decisionCreate = z.object({
  project: z.string().nullable().optional(),
  task: z.string().nullable().optional(),
  title: z.string().min(1).max(300),
  decision: z.string().min(1).max(20_000),
  context: z.string().max(20_000).optional(),
  rationale: z.string().max(20_000).optional(),
  alternatives: z.string().max(20_000).optional(),
  status: z.enum(DECISION_STATUSES).optional(),
});

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const type = c.req.header("content-type") ?? "";
  // Requiring JSON forces a CORS preflight, which blocks drive-by writes from random web pages.
  if (!type.includes("application/json")) throw new SwarmError(415, "unsupported_media_type", "Send JSON with Content-Type: application/json");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Malformed JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function createApp(svc: Service, config: AppConfig) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof SwarmError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    console.error(err);
    return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
  });

  const owner = () => svc.actor(svc.settings().owner);

  /** Who is calling? Agents present their token; the human uses the admin token or (locally) nothing. */
  const resolveActor = (c: Context<Env>): Actor | null => {
    const internal = c.env?.internalActor;
    if (internal) return svc.findActor(internal);
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : c.req.query("token");
    if (token) {
      if (config.adminToken && token === config.adminToken) return owner();
      return svc.actorByToken(token);
    }
    if (!config.adminToken && config.trustLocal) {
      const addr = c.env?.incoming?.socket?.remoteAddress;
      const host = c.req.header("host") ?? new URL(c.req.url).host;
      // Host check defeats DNS-rebinding: a hostile page cannot pose as localhost.
      if (addr && LOOPBACK.has(addr) && LOCAL_HOSTS.test(host)) return owner();
    }
    return null;
  };

  const authed = async (c: Context<Env>, next: () => Promise<void>) => {
    const actor = resolveActor(c);
    if (!actor) return c.json({ error: { code: "unauthorized", message: "Missing or invalid token" } }, 401);
    c.set("actor", actor);
    if (actor.kind === "agent") svc.touchActor(actor.id);
    await next();
  };

  const requireHuman = (c: Context<Env>) => {
    if (c.get("actor").kind !== "human") throw forbidden("Only humans can do that");
  };

  /** Agents act as themselves; humans may act on behalf of an actor via ?actor= (e.g. to read an agent's inbox). */
  const subject = (c: Context<Env>): string => {
    const me = c.get("actor");
    const asked = c.req.query("actor");
    if (asked && asked !== me.id) {
      if (me.kind !== "human") throw forbidden("Agents can only act as themselves");
      return svc.actor(asked).id;
    }
    return me.id;
  };

  const md = (c: Context, text: string) => c.body(text, 200, { "content-type": "text/markdown; charset=utf-8" });

  // ---------------------------------------------------------------- public
  app.get("/api/health", (c) => c.json({ ok: true, name: "tunadesk", version: config.version }));

  app.get("/llms.txt", (c) =>
    c.text(
      [
        "# Tunadesk",
        "> A shared project & task desk for AI agents and their human. Agents connect over MCP (preferred) or this REST API.",
        "",
        "Auth: `Authorization: Bearer <agent token>` (tokens are issued in the UI → Agents).",
        "",
        "## Read (markdown, token-cheap)",
        "- GET /api/briefing.md — your inbox, ranked next tasks, portfolio, decisions",
        "- GET /api/portfolio.md — every project and agent at a glance",
        "- GET /api/projects/{KEY}/board.md — one project board with its brief",
        "- GET /api/tasks/{KEY-N}.md — one task with its updates",
        "",
        "## Write (JSON)",
        "- POST /api/tasks/{KEY-N}/claim {minutes?}",
        "- POST /api/tasks/{KEY-N}/comments {body} — use @agent-id to mention",
        "- POST /api/tasks/{KEY-N}/handoff {to, message, status?, subtasks?, tokens_used?}",
        "- POST /api/tasks/{KEY-N}/complete {summary, tokens_used?, status?}",
        "- POST /api/decisions {project, task?, title, decision, rationale?}",
        "- POST /api/tasks {project, title, ...}",
        "",
        "MCP endpoint: POST /mcp (Streamable HTTP, same bearer token).",
      ].join("\n"),
    ),
  );

  if (config.mcp) {
    const handler = config.mcp;
    app.all("/mcp", authed, (c) => handler(c.req.raw, c.get("actor")));
  }

  // ---------------------------------------------------------------- authed api
  const api = new Hono<Env>();
  api.use("*", authed);

  api.get("/me", (c) => {
    const me = c.get("actor");
    return c.json({ actor: me, budget: svc.budget(me.id), unread: svc.unreadCount(me.id), owner: svc.settings().owner, version: config.version });
  });

  api.get("/overview", (c) => c.json(svc.overview()));
  api.get("/portfolio.md", (c) => md(c, renderPortfolio(svc)));
  api.get("/briefing", (c) => c.json(svc.briefing(subject(c), { project: c.req.query("project") })));
  api.get("/briefing.md", (c) => md(c, renderBriefing(svc, subject(c), { project: c.req.query("project") })));

  // settings
  api.get("/settings", (c) => c.json(svc.settings()));
  api.patch("/settings", async (c) => {
    requireHuman(c);
    const b = await body(c, z.object({ loop_guard_limit: z.number().int().min(1).max(100).optional(), default_lease_minutes: z.number().int().min(1).max(24 * 60).optional() }));
    for (const [k, v] of Object.entries(b)) if (v !== undefined) svc.setSetting(k, v);
    return c.json(svc.settings());
  });

  // actors
  api.get("/actors", (c) => {
    const actors = svc.listActors({ include_archived: c.req.query("archived") === "1" });
    return c.json(actors.map((a) => ({ ...a, budget: svc.budget(a.id), unread: svc.unreadCount(a.id) })));
  });
  api.post("/actors", async (c) => {
    requireHuman(c);
    const b = await body(c, actorCreate);
    const res = svc.createActor(b, c.get("actor").id);
    return c.json(res, 201);
  });
  api.get("/actors/:id", (c) => {
    const a = svc.actor(c.req.param("id"));
    return c.json({
      actor: a,
      budget: svc.budget(a.id),
      tasks: svc.listTasks({ assignee: a.id }),
      next: svc.recommend(a.id, 8),
      runs: svc.runs({ actor: a.id, limit: 20 }),
      activity: svc.activity({ actor: a.id, limit: 30 }),
    });
  });
  api.patch("/actors/:id", async (c) => {
    const me = c.get("actor");
    const id = c.req.param("id");
    if (me.kind !== "human" && me.id !== id) throw forbidden("Agents can only update themselves");
    const b = await body(c, actorPatch);
    if (me.kind !== "human" && (b.trigger || b.token_budget !== undefined || b.archived !== undefined)) throw forbidden("Only humans change triggers, budgets or archive state");
    return c.json(svc.updateActor(id, b, me.id));
  });
  api.post("/actors/:id/token", (c) => {
    requireHuman(c);
    return c.json({ token: svc.rotateToken(c.req.param("id"), c.get("actor").id) });
  });
  api.get("/actors/:id/connect", (c) => {
    const a = svc.actor(c.req.param("id"));
    const origin = config.deskUrl ?? new URL(c.req.url).origin;
    return c.json(connectSnippets({ deskUrl: origin, agentId: a.id }));
  });
  api.post("/actors/:id/wake", async (c) => {
    const target = svc.actor(c.req.param("id"));
    if (target.kind !== "agent") throw badRequest("Only agents can be woken");
    const b = await body(c, z.object({ task: z.string().optional(), message: z.string().max(4000).optional() }));
    const task = b.task ? svc.task(b.task) : null;
    const res = svc.notify(target.id, "mentioned", {
      sender: c.get("actor").id,
      task_id: task?.id ?? null,
      project_id: task?.project_id ?? null,
      message: b.message || (task ? `Please pick up ${task.key}: ${task.title}` : "Check your briefing for work."),
    });
    return c.json({ ok: true, notification: res?.id, trigger: target.trigger.enabled ? target.trigger.type : "none" });
  });
  api.post("/heartbeat", async (c) => {
    const b = await body(c, z.object({ status: z.enum(["idle", "working", "offline", "blocked"]).optional(), note: z.string().max(200).optional() }));
    svc.touchActor(c.get("actor").id, b.status, b.note);
    return c.json({ ok: true });
  });

  // usage + budgets
  api.post("/usage", async (c) => {
    const b = await body(c, z.object({ tokens: z.number().int().min(0), task: z.string().optional(), cost_usd: z.number().min(0).optional(), note: z.string().max(500).optional() }));
    return c.json(svc.recordUsage(subject(c), b.tokens, b));
  });
  api.get("/recommend", (c) => c.json(svc.recommend(subject(c), Number(c.req.query("limit") ?? 5))));

  // projects
  api.get("/projects", (c) => c.json(svc.listProjects({ include_archived: c.req.query("archived") === "1" })));
  api.post("/projects", async (c) => {
    const b = await body(c, projectCreate);
    return c.json(svc.createProject(b, c.get("actor").id), 201);
  });
  api.get("/projects/:ref", (c) => {
    const p = svc.project(c.req.param("ref"));
    return c.json({ project: p, groups: svc.groups(p.id) });
  });
  api.get("/projects/:ref/board.md", (c) => md(c, renderBoard(svc, c.req.param("ref"), { include_closed: c.req.query("closed") === "1" })));
  api.patch("/projects/:ref", async (c) => {
    const b = await body(c, projectPatch);
    return c.json(svc.updateProject(c.req.param("ref"), b, c.get("actor").id));
  });
  api.delete("/projects/:ref", (c) => {
    requireHuman(c);
    svc.deleteProject(c.req.param("ref"), c.get("actor").id);
    return c.json({ ok: true });
  });
  api.get("/projects/:ref/groups", (c) => c.json(svc.groups(c.req.param("ref"))));
  api.post("/projects/:ref/groups", async (c) => {
    const b = await body(c, z.object({ name: z.string().min(1).max(60), color: z.string().max(20).optional() }));
    return c.json(svc.createGroup(c.req.param("ref"), b, c.get("actor").id), 201);
  });
  api.patch("/groups/:id", async (c) => {
    const b = await body(c, z.object({ name: z.string().min(1).max(60).optional(), color: z.string().max(20).optional(), position: z.number().optional(), collapsed: z.boolean().optional() }));
    return c.json(svc.updateGroup(c.req.param("id"), b, c.get("actor").id));
  });
  api.delete("/groups/:id", (c) => {
    svc.deleteGroup(c.req.param("id"), c.get("actor").id);
    return c.json({ ok: true });
  });

  // tasks
  api.get("/tasks", (c) => {
    const q = c.req.query();
    const tasks = svc.listTasks({
      project: q.project,
      status: csv(q.status) as TaskStatus[] | undefined,
      assignee: q.assignee === undefined ? undefined : q.assignee === "me" ? subject(c) : q.assignee,
      priority: csv(q.priority) as Priority[] | undefined,
      type: csv(q.type) as TaskType[] | undefined,
      parent: q.parent,
      q: q.q,
      include_closed: q.closed === "1",
      limit: q.limit ? Number(q.limit) : undefined,
    });
    if (q.format === "md") return md(c, renderTaskList(tasks));
    return c.json(tasks);
  });
  api.post("/tasks", async (c) => {
    const b = await body(c, taskCreate);
    return c.json(svc.createTask(b, c.get("actor").id), 201);
  });
  api.get("/tasks/:ref{.+\\.md}", (c) => md(c, renderTask(svc, c.req.param("ref").replace(/\.md$/, ""))));
  api.get("/tasks/:ref", (c) => {
    const t = svc.task(c.req.param("ref"));
    return c.json({
      task: t,
      comments: svc.comments(t.id),
      subtasks: svc.listTasks({ parent: t.id, include_closed: true }),
      decisions: svc.decisions({ task: t.id }),
      activity: svc.activity({ task: t.id, limit: 100 }).filter((a) => a.type !== "notification"),
      runs: svc.runs({ limit: 200 }).filter((r) => r.task_id === t.id).slice(0, 20),
    });
  });
  api.patch("/tasks/:ref", async (c) => {
    const b = await body(c, taskPatch);
    return c.json(svc.updateTask(c.req.param("ref"), b, c.get("actor").id));
  });
  api.delete("/tasks/:ref", (c) => {
    svc.deleteTask(c.req.param("ref"), c.get("actor").id);
    return c.json({ ok: true });
  });
  api.post("/tasks/:ref/claim", async (c) => {
    const b = c.req.header("content-type")?.includes("json") ? await body(c, z.object({ minutes: z.number().int().min(1).max(24 * 60).optional() })) : {};
    return c.json(svc.claim(c.req.param("ref"), subject(c), b.minutes));
  });
  api.post("/tasks/:ref/release", async (c) => {
    const b = c.req.header("content-type")?.includes("json") ? await body(c, z.object({ note: z.string().max(20_000).optional() })) : {};
    return c.json(svc.release(c.req.param("ref"), subject(c), b.note));
  });
  api.post("/tasks/:ref/complete", async (c) => {
    const b = await body(
      c,
      z.object({ summary: z.string().min(1).max(50_000), tokens_used: z.number().int().min(0).optional(), status: z.enum(["done", "review", "testing"]).optional(), next_assignee: z.string().optional() }),
    );
    return c.json(svc.complete(c.req.param("ref"), subject(c), b));
  });
  api.post("/tasks/:ref/handoff", async (c) => {
    const b = await body(
      c,
      z.object({
        to: z.string(),
        message: z.string().min(1).max(50_000),
        status: z.enum(TASK_STATUSES).optional(),
        tokens_used: z.number().int().min(0).optional(),
        subtasks: z
          .array(z.object({ title: z.string().min(1).max(300), description: z.string().max(20_000).optional(), priority: z.enum(PRIORITIES).optional(), type: z.enum(TASK_TYPES).optional() }))
          .max(50)
          .optional(),
      }),
    );
    return c.json(svc.handoff(c.req.param("ref"), subject(c), b));
  });
  api.get("/tasks/:ref/comments", (c) => c.json(svc.comments(c.req.param("ref"))));
  api.post("/tasks/:ref/comments", async (c) => {
    const b = await body(c, z.object({ body: z.string().min(1).max(50_000), kind: z.enum(["comment", "report"]).optional() }));
    return c.json(svc.addComment(c.req.param("ref"), c.get("actor").id, b.body, b.kind), 201);
  });
  api.post("/tasks/:ref/links", async (c) => {
    const b = await body(c, z.object({ blocked_by: z.string() }));
    return c.json(svc.link(b.blocked_by, c.req.param("ref"), c.get("actor").id));
  });
  api.delete("/tasks/:ref/links/:blocker", (c) => c.json(svc.unlink(c.req.param("blocker"), c.req.param("ref"), c.get("actor").id)));

  // decisions
  api.get("/decisions", (c) => {
    const list = svc.decisions({ project: c.req.query("project"), task: c.req.query("task"), q: c.req.query("q"), limit: Number(c.req.query("limit") ?? 100) });
    return c.req.query("format") === "md" ? md(c, renderDecisions(list)) : c.json(list);
  });
  api.post("/decisions", async (c) => c.json(svc.logDecision(await body(c, decisionCreate), c.get("actor").id), 201));
  api.patch("/decisions/:id", async (c) => {
    const b = await body(c, decisionCreate.omit({ project: true, task: true }).partial());
    return c.json(svc.updateDecision(c.req.param("id"), b, c.get("actor").id));
  });

  // inbox
  api.get("/inbox", (c) => {
    const list = svc.inbox(subject(c), { unread_only: c.req.query("unread") === "1", limit: Number(c.req.query("limit") ?? 50) });
    return c.req.query("format") === "md" ? md(c, renderInbox(list)) : c.json(list);
  });
  api.post("/inbox/read", async (c) => {
    const b = await body(c, z.object({ ids: z.union([z.array(z.string()), z.literal("all")]) }));
    svc.markRead(subject(c), b.ids);
    return c.json({ ok: true, unread: svc.unreadCount(subject(c)) });
  });

  // activity, runs
  api.get("/activity", (c) =>
    c.json(
      svc
        .activity({ project: c.req.query("project"), task: c.req.query("task"), actor: c.req.query("by"), limit: Number(c.req.query("limit") ?? 50), after: c.req.query("after") ? Number(c.req.query("after")) : undefined })
        .filter((a) => a.type !== "notification"),
    ),
  );
  api.get("/runs", (c) => c.json(svc.runs({ actor: c.req.query("actor"), limit: Number(c.req.query("limit") ?? 50) })));
  api.get("/runs/:id", (c) => c.json(svc.run(c.req.param("id"))));

  // live updates
  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      const onEvent = (e: Activity) => {
        void stream.writeSSE({ event: "activity", data: JSON.stringify(e), id: String(e.id) });
      };
      svc.events.on("event", onEvent);
      stream.onAbort(() => {
        alive = false;
        svc.events.off("event", onEvent);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ actor: c.get("actor").id }) });
      while (alive) {
        await stream.sleep(25_000);
        if (alive) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    }),
  );

  app.route("/api", api);
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "No such endpoint" } }, 404));

  // ---------------------------------------------------------------- web app
  if (config.webDir && existsSync(config.webDir)) {
    const root = normalize(config.webDir);
    const index = join(root, "index.html");
    app.get("*", (c) => {
      const rel = decodeURIComponent(new URL(c.req.url).pathname);
      const file = normalize(join(root, rel));
      if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
        const headers: Record<string, string> = { "content-type": MIME[extname(file)] ?? "application/octet-stream" };
        if (rel.startsWith("/assets/")) headers["cache-control"] = "public, max-age=31536000, immutable";
        return c.body(readFileSync(file), 200, headers);
      }
      if (existsSync(index)) return c.body(readFileSync(index), 200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
      return c.notFound();
    });
  } else {
    app.get("/", (c) => c.text("Tunadesk API is running. Build the web app (npm run build) to get the UI, or run `npm run dev` for development."));
  }

  return app;
}

export type TunadeskApp = ReturnType<typeof createApp>;
