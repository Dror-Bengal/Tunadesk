import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PRIORITIES, TASK_STATUSES, TASK_TYPES, DECISION_STATUSES } from "../domain.js";

/** Transport-agnostic access to the REST API: in-process for /mcp, over HTTP for the stdio bridge. */
export type DeskCall = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; text: string }>;

export const MCP_INSTRUCTIONS = `Tunadesk is the shared project & task desk for every agent working with this human, across platforms (Claude Code, Codex, Grok, ...).

Work protocol — follow it every session:
0. FIRST SESSION EVER: call \`onboarding_guide\` and follow it to register your projects and tasks without duplicates.
1. START: call \`briefing\` first. It shows your inbox (handoffs, mentions, assignments), ranked next tasks and the whole portfolio.
2. CLAIM: before working on a task call \`claim_task\` so other agents don't collide with you. Re-claim to extend a long job.
3. UPDATE: post short progress notes with \`comment\` (mention teammates with @id). Keep the project brief current with \`update_project\` when you learn something durable.
4. DECIDE: whenever you make a non-obvious choice (architecture, library, scope cut, trade-off) call \`log_decision\` with the rationale.
5. FINISH: call \`complete_task\` with a summary of what changed and how it was verified, or \`handoff_task\` to pass work to another agent (e.g. dev → tester, tester → dev with bug sub-tasks). Always include tokens_used when you know it.
6. Never leave a task claimed when you stop. Never silently drop work: release it with a note instead.
7. NO DUPLICATES: before creating a project or task, check what exists (\`portfolio\`, \`find_similar_tasks\`). If the desk says a task is a possible duplicate, join the existing one (comment + @mention) instead.
Task keys look like PROJ-12. Agent ids look like @claude-dev.`;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

export function createMcpServer(call: DeskCall, version: string): McpServer {
  const server = new McpServer({ name: "tunadesk", version }, { instructions: MCP_INSTRUCTIONS });

  const run = async (method: Parameters<DeskCall>[0], path: string, body?: unknown, format?: (json: any) => string) => {
    try {
      const res = await call(method, path, body);
      if (res.status >= 400) {
        let msg = res.text;
        try {
          msg = JSON.parse(res.text).error?.message ?? msg;
        } catch {
          /* plain text */
        }
        return text(`Error ${res.status}: ${msg}`, true);
      }
      if (!format) return text(res.text);
      return text(format(JSON.parse(res.text)));
    } catch (err) {
      return text(`Tunadesk is unreachable: ${(err as Error).message}`, true);
    }
  };
  const q = (params: Record<string, string | number | boolean | undefined | null>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
    const str = s.toString();
    return str ? `?${str}` : "";
  };
  const enc = encodeURIComponent;
  const taskSummary = (t: any) =>
    `${t.key} · ${t.title} — ${t.status}, ${t.priority}${t.assignee ? `, @${t.assignee}` : ""}${t.lease_holder ? `, claimed by @${t.lease_holder} until ${t.lease_expires_at}` : ""}`;

  // ------------------------------------------------------------------ read
  server.registerTool(
    "briefing",
    {
      title: "Session briefing",
      description: "START HERE. Your inbox, ranked next tasks (weighed against your token budget), open tasks, the portfolio of projects, recent decisions and teammates.",
      inputSchema: { project: z.string().optional().describe("Focus on one project key, e.g. WEB") },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => run("GET", `/api/briefing.md${q({ project })}`),
  );

  server.registerTool(
    "portfolio",
    { title: "Portfolio overview", description: "Every project, agent, in-flight task and recent decision — the big picture.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => run("GET", "/api/portfolio.md"),
  );

  server.registerTool(
    "project_board",
    {
      title: "Project board",
      description: "One project's brief (its long-term memory), groups, tasks with sub-tasks and decisions.",
      inputSchema: { project: z.string().describe("Project key"), include_closed: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ project, include_closed }) => run("GET", `/api/projects/${enc(project)}/board.md${q({ closed: include_closed ? 1 : undefined })}`),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "Find tasks",
      description: "Search/filter tasks. Comma-separate multiple statuses/priorities/types. assignee='me' for yours, 'unassigned' for free work.",
      inputSchema: {
        project: z.string().optional(),
        status: z.string().optional().describe(`Comma list of ${TASK_STATUSES.join("|")}`),
        assignee: z.string().optional(),
        priority: z.string().optional(),
        type: z.string().optional(),
        query: z.string().optional().describe("Text search in key/title/description"),
        include_closed: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) =>
      run(
        "GET",
        `/api/tasks${q({ format: "md", project: a.project, status: a.status, assignee: a.assignee, priority: a.priority, type: a.type, q: a.query, closed: a.include_closed ? 1 : undefined, limit: a.limit ?? 50 })}`,
      ),
  );

  server.registerTool(
    "get_task",
    { title: "Read a task", description: "Full task: description, sub-tasks, decisions and the update thread.", inputSchema: { task: z.string().describe("Task key, e.g. WEB-12") }, annotations: { readOnlyHint: true } },
    async ({ task }) => run("GET", `/api/tasks/${enc(task)}.md`),
  );

  server.registerTool(
    "next_tasks",
    {
      title: "What should I do next?",
      description: "Your ranked work queue with reasons (priority, deadlines, blockers, in-progress, token budget).",
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      run("GET", `/api/recommend${q({ limit: limit ?? 5 })}`, undefined, (recs: any[]) =>
        recs.length ? recs.map((r, i) => `${i + 1}. ${taskSummary(r.task)}\n   score ${r.score}: ${r.reasons.join("; ")}`).join("\n") : "Nothing ready for you right now.",
      ),
  );

  server.registerTool(
    "inbox",
    {
      title: "Inbox",
      description: "Handoffs, mentions, assignments and review requests addressed to you.",
      inputSchema: { unread_only: z.boolean().optional(), mark_read: z.boolean().optional().describe("Mark everything read after listing") },
    },
    async ({ unread_only, mark_read }) => {
      const res = await run("GET", `/api/inbox${q({ format: "md", unread: unread_only === false ? undefined : 1 })}`);
      if (mark_read && !res.isError) await call("POST", "/api/inbox/read", { ids: "all" });
      return res;
    },
  );

  server.registerTool(
    "list_decisions",
    {
      title: "Decision log",
      description: "Read the running decision log (why things are the way they are). Check it before re-deciding something.",
      inputSchema: { project: z.string().optional(), task: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => run("GET", `/api/decisions${q({ format: "md", project: a.project, task: a.task, q: a.query, limit: a.limit ?? 20 })}`),
  );

  server.registerTool(
    "list_agents",
    { title: "Teammates", description: "Agents and humans on the desk with role, status and budget.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () =>
      run("GET", "/api/actors", undefined, (actors: any[]) =>
        actors
          .map(
            (a) =>
              `@${a.id} ${a.name} — ${a.kind === "human" ? "human" : `${a.platform}, ${a.role}`} — ${a.status}${a.status_note ? `: ${a.status_note}` : ""}${a.budget?.budget ? ` — ${a.budget.remaining} tokens left this ${a.budget.period}` : ""}`,
          )
          .join("\n"),
      ),
  );

  server.registerTool(
    "onboarding_guide",
    {
      title: "Onboarding guide",
      description: "First session on the desk: step-by-step guide to register your projects, tasks and decisions without duplicating other agents' work.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => run("GET", "/api/onboarding.md"),
  );

  server.registerTool(
    "onboarding_report",
    {
      title: "Report onboarding",
      description: "Finish onboarding: summarise projects found/created, tasks created/joined (keys) and anything the human should decide.",
      inputSchema: { summary: z.string() },
    },
    async ({ summary }) => run("POST", "/api/onboarding/report", { summary }, () => "Reported to the human. Welcome aboard."),
  );

  server.registerTool(
    "find_similar_tasks",
    {
      title: "Find similar tasks",
      description: "Before creating a task, check whether the same work already exists in the project (fuzzy title match, works in English and Hebrew).",
      inputSchema: { project: z.string(), title: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ project, title }) =>
      run("GET", `/api/tasks/similar${q({ project, title })}`, undefined, (list: any[]) =>
        list.length ? list.map((t) => `${taskSummary(t)} — ${Math.round(t.score * 100)}% similar`).join("\n") : "No similar tasks."),
  );

  // ------------------------------------------------------------------ write
  server.registerTool(
    "claim_task",
    {
      title: "Claim a task",
      description: "Take a lease on a task before working on it (sets you as assignee if free, moves todo → in_progress). Fails if another agent holds it or it is blocked.",
      inputSchema: { task: z.string(), minutes: z.number().int().min(5).max(1440).optional().describe("Lease length, default 60") },
    },
    async ({ task, minutes }) => run("POST", `/api/tasks/${enc(task)}/claim`, { minutes }, (t) => `Claimed: ${taskSummary(t)}`),
  );

  server.registerTool(
    "release_task",
    { title: "Release a task", description: "Give up your claim without finishing (explain why in note).", inputSchema: { task: z.string(), note: z.string().optional() } },
    async ({ task, note }) => run("POST", `/api/tasks/${enc(task)}/release`, { note }, (t) => `Released: ${taskSummary(t)}`),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a task",
      description: "Finish a task with a report (what changed, files, how verified). status='review'/'testing' + next_assignee hands it to a reviewer/tester instead of closing.",
      inputSchema: {
        task: z.string(),
        summary: z.string().describe("Markdown report of the work"),
        tokens_used: z.number().int().min(0).optional(),
        status: z.enum(["done", "review", "testing"]).optional(),
        next_assignee: z.string().optional(),
      },
    },
    async ({ task, ...rest }) => run("POST", `/api/tasks/${enc(task)}/complete`, rest, (t) => `Completed: ${taskSummary(t)}`),
  );

  server.registerTool(
    "handoff_task",
    {
      title: "Hand off to another agent",
      description:
        "Pass a task to a teammate with context — e.g. tester → developer with one bug sub-task per issue. Wakes the target agent if it has a trigger. The desk pauses tasks that bounce too often.",
      inputSchema: {
        task: z.string(),
        to: z.string().describe("Agent id, e.g. claude-dev"),
        message: z.string().describe("What you did, what they need to do, where to look"),
        status: z.enum(TASK_STATUSES).optional(),
        tokens_used: z.number().int().min(0).optional(),
        subtasks: z
          .array(z.object({ title: z.string(), description: z.string().optional(), priority: z.enum(PRIORITIES).optional(), type: z.enum(TASK_TYPES).optional() }))
          .optional()
          .describe("Follow-up items (e.g. bugs found), created as sub-tasks assigned to the target"),
      },
    },
    async ({ task, ...rest }) =>
      run("POST", `/api/tasks/${enc(task)}/handoff`, rest, (r) =>
        r.loop_guard
          ? `Loop guard tripped: ${r.task.key} has been handed off too many times and is now blocked for a human decision.`
          : `Handed off ${r.task.key} to @${r.task.assignee} (${r.task.status}).${r.subtasks.length ? ` Sub-tasks: ${r.subtasks.map((s: any) => s.key).join(", ")}` : ""}`,
      ),
  );

  server.registerTool(
    "comment",
    {
      title: "Post an update",
      description: "Add a progress update or question to a task. Mention teammates with @id to notify (and possibly wake) them.",
      inputSchema: { task: z.string(), body: z.string() },
    },
    async ({ task, body }) => run("POST", `/api/tasks/${enc(task)}/comments`, { body }, () => `Posted on ${task}.`),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description: "Add a task (or sub-task with parent) to a project. The desk refuses likely duplicates and lists them — join those instead (comment + @mention), or pass force: true if the work is genuinely different.",
      inputSchema: {
        project: z.string(),
        title: z.string(),
        description: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
        type: z.enum(TASK_TYPES).optional(),
        status: z.enum(TASK_STATUSES).optional(),
        assignee: z.string().optional(),
        parent: z.string().optional(),
        group: z.string().optional().describe("Board group name, e.g. Now / Next / Later"),
        due_at: z.string().optional().describe("ISO date"),
        estimate_tokens: z.number().int().min(0).optional(),
        blocked_by: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        force: z.boolean().optional().describe("Create even if similar tasks exist (only after checking they are different work)"),
      },
    },
    async (a) => run("POST", "/api/tasks", a, (t) => `Created ${taskSummary(t)}`),
  );

  server.registerTool(
    "update_task",
    {
      title: "Update a task",
      description: "Change status, priority, assignee, description, due date, estimate, group…",
      inputSchema: {
        task: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        type: z.enum(TASK_TYPES).optional(),
        assignee: z.string().nullable().optional(),
        group: z.string().optional(),
        due_at: z.string().nullable().optional(),
        estimate_tokens: z.number().int().min(0).optional(),
        tags: z.array(z.string()).optional(),
        blocked_by: z.string().optional().describe("Add a blocker task key"),
        as_of: z.string().optional().describe("When setting a status from memory rather than live work: the date that knowledge is current as of. The desk refuses it if the status changed later."),
      },
    },
    async ({ task, blocked_by, ...patch }) => {
      if (blocked_by) {
        const linked = await run("POST", `/api/tasks/${enc(task)}/links`, { blocked_by });
        if (linked.isError) return linked;
      }
      return run("PATCH", `/api/tasks/${enc(task)}`, patch, (t) => `Updated ${taskSummary(t)}`);
    },
  );

  server.registerTool(
    "log_decision",
    {
      title: "Log a decision",
      description: "Record a decision with context and rationale in the running decision log so every agent (and the human) knows why.",
      inputSchema: {
        title: z.string(),
        decision: z.string(),
        project: z.string().optional(),
        task: z.string().optional(),
        context: z.string().optional(),
        rationale: z.string().optional(),
        alternatives: z.string().optional().describe("Options considered and why they lost"),
        status: z.enum(DECISION_STATUSES).optional().describe("Use 'proposed' when the human should confirm"),
      },
    },
    async (a) => run("POST", "/api/decisions", a, (d) => `Logged ${d.ref}: ${d.title}`),
  );

  server.registerTool(
    "report_usage",
    {
      title: "Report token usage",
      description: "Record tokens you spent (optionally on a task) so budgets and prioritisation stay accurate.",
      inputSchema: { tokens: z.number().int().min(0), task: z.string().optional(), cost_usd: z.number().min(0).optional(), note: z.string().optional() },
    },
    async (a) =>
      run("POST", "/api/usage", a, (b) => (b.budget ? `Recorded. ${b.remaining} of ${b.budget} tokens left this ${b.period}.` : `Recorded. ${b.used} tokens used this ${b.period}.`)),
  );

  server.registerTool(
    "set_status",
    {
      title: "Set my status",
      description: "Tell the desk what you are doing (shown to the human and teammates).",
      inputSchema: { status: z.enum(["idle", "working", "offline", "blocked"]), note: z.string().optional() },
    },
    async (a) => run("POST", "/api/heartbeat", a, () => `Status set to ${a.status}.`),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description: "Register a new project (gets Now/Next/Later groups). Put goals, stack and conventions in brief.",
      inputSchema: {
        name: z.string(),
        key: z.string().optional().describe("2-8 letters; derived from the name if omitted"),
        description: z.string().optional(),
        repo_path: z.string().optional(),
        repo_url: z.string().optional(),
        brief: z.string().optional(),
        priority: z.enum(PRIORITIES).optional(),
      },
    },
    async (a) =>
      run("POST", "/api/projects", a, (p) =>
        p.existing
          ? `Project already on the desk: ${p.key} · ${p.name} (matched by remote/folder/name) — use it; nothing was created.`
          : `Created project ${p.key} · ${p.name}`,
      ),
  );

  server.registerTool(
    "update_project",
    {
      title: "Update a project",
      description: "Update a project's brief (its shared long-term memory), description, status or repo info.",
      inputSchema: {
        project: z.string(),
        brief: z.string().optional().describe("Full replacement markdown"),
        as_of: z
          .string()
          .optional()
          .describe("REQUIRED when replacing a brief: the date your knowledge of this project is current as of (your last session/conversation/commit on it), e.g. 2026-10-20. The desk refuses briefs older than the current one."),
        evidence: z.string().optional().describe("What the as_of is based on, e.g. 'session 2026-10-20' or 'commit a1b2c3 (2026-10-19)'"),
        merged_notes: z.array(z.string()).optional().describe("Ids of brief notes you folded into this brief"),
        description: z.string().optional(),
        status: z.enum(["active", "paused", "done", "archived"]).optional(),
        priority: z.enum(PRIORITIES).optional(),
        repo_path: z.string().optional(),
        repo_url: z.string().optional(),
      },
    },
    async ({ project, ...patch }) => run("PATCH", `/api/projects/${enc(project)}`, patch, (p) => `Updated ${p.key}${p.brief_as_of ? ` (brief as of ${p.brief_as_of.slice(0, 10)})` : ""}.`),
  );

  server.registerTool(
    "add_brief_note",
    {
      title: "Add a note to a project brief",
      description:
        "Share what you know about a project when you may not replace its brief (your knowledge is older, or another agent maintains it). The maintainer or the human merges notes into the brief.",
      inputSchema: {
        project: z.string(),
        note: z.string().describe("What you know that the brief is missing or gets wrong"),
        as_of: z.string().optional().describe("Date your knowledge is current as of"),
        evidence: z.string().optional(),
      },
    },
    async ({ project, note, as_of, evidence }) => run("POST", `/api/projects/${enc(project)}/notes`, { body: note, as_of, evidence }, () => `Note added to the ${project} brief.`),
  );

  return server;
}
