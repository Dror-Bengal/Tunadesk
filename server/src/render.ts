// Compact markdown views of desk state. These are what agents read: dense, scannable, cheap in tokens.
import type { Service, Task, Decision, Notification, Recommendation, Budget, Comment, Activity } from "./service.js";
import { truncate } from "./util.js";

const STATUS_ICON: Record<string, string> = {
  backlog: "·",
  todo: "○",
  in_progress: "◐",
  review: "◑",
  testing: "◑",
  blocked: "⛔",
  done: "●",
  canceled: "✕",
};

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

export function taskLine(t: Task, opts: { project?: boolean } = {}): string {
  const bits = [`${STATUS_ICON[t.status] ?? "○"} **${t.key}**`, t.title, `[${t.status}·${t.priority}·${t.type}]`];
  if (t.assignee) bits.push(`@${t.assignee}`);
  if (t.due_at) bits.push(`due ${t.due_at.slice(0, 10)}`);
  if (t.blocked_by.length) bits.push(`blocked by ${t.blocked_by.join(",")}`);
  if (t.lease_holder) bits.push(`🔒${t.lease_holder}`);
  if (t.subtask_count) bits.push(`${t.subtasks_done}/${t.subtask_count} sub`);
  if (t.estimate_tokens) bits.push(`est ${fmtTokens(t.estimate_tokens)}`);
  if (opts.project === false) return `- ${bits.join(" ")}`;
  return `- ${bits.join(" ")}`;
}

function budgetLine(b: Budget): string {
  if (!b.budget) return `unlimited (used ${fmtTokens(b.used)} this ${b.period})`;
  return `${fmtTokens(b.remaining ?? 0)} of ${fmtTokens(b.budget)} left this ${b.period} (${Math.round((b.ratio ?? 0) * 100)}% used)`;
}

function notificationLine(n: Notification): string {
  return `- [${n.type}] ${n.task_key ? `**${n.task_key}** ` : ""}from @${n.sender ?? "system"}: ${truncate(n.message.replace(/\s+/g, " "), 200)} _(id ${n.id})_`;
}

function decisionLine(d: Decision): string {
  return `- **${d.ref}** ${d.title} — ${truncate(d.decision.replace(/\s+/g, " "), 160)}${d.status !== "accepted" ? ` _(${d.status})_` : ""}`;
}

function recLine(r: Recommendation): string {
  return `${taskLine(r.task)}\n  ↳ score ${r.score}: ${r.reasons.join("; ")}`;
}

export function renderBriefing(svc: Service, actorId: string, opts: { project?: string } = {}): string {
  const b = svc.briefing(actorId, opts);
  const out: string[] = [];
  out.push(`# Tunadesk briefing for @${b.me.id} (${b.me.name})`);
  out.push(`Role: ${b.me.role} · Platform: ${b.me.platform} · Budget: ${budgetLine(b.budget)}`);
  out.push("");
  out.push(`## Inbox (${b.inbox.length} unread)`);
  out.push(b.inbox.length ? b.inbox.map(notificationLine).join("\n") : "_Nothing new._");
  out.push("");
  out.push("## Do next (ranked)");
  out.push(b.next.length ? b.next.map(recLine).join("\n") : "_No ready work for you. Ask the human or pick something from the portfolio._");
  out.push("");
  out.push(`## Your open tasks (${b.my_tasks.length})`);
  out.push(b.my_tasks.length ? b.my_tasks.map((t) => taskLine(t)).join("\n") : "_None._");
  out.push("");
  out.push("## Portfolio");
  for (const p of b.projects) {
    const c = p.counts;
    const counts = ["in_progress", "review", "testing", "blocked", "todo"]
      .filter((s) => c[s])
      .map((s) => `${c[s]} ${s}`)
      .join(", ");
    out.push(`- **${p.key}** ${p.name} [${p.status}·${p.priority}] — ${p.open_tasks} open${counts ? ` (${counts})` : ""}${p.repo_path ? ` · repo ${p.repo_path}` : ""}`);
    if (p.brief) out.push(`  ${truncate(p.brief.replace(/\s+/g, " "), 220)}`);
  }
  if (!b.projects.length) out.push("_No active projects._");
  out.push("");
  out.push("## Recent decisions");
  out.push(b.decisions.length ? b.decisions.map(decisionLine).join("\n") : "_None logged yet._");
  out.push("");
  out.push("## Teammates");
  out.push(
    b.teammates
      .map((t) => (t.kind === "human" ? `- @${t.id} ${t.name} (human — your boss; ask with @${t.id})` : `- @${t.id} ${t.name} (${t.platform}, ${t.role}) — ${t.status}${t.status_note ? `: ${t.status_note}` : ""}`))
      .join("\n"),
  );
  out.push("");
  out.push(
    "_Protocol: claim before you work → comment progress → log decisions → complete or hand off (with tokens_used). Mention teammates with @id._",
  );
  return out.join("\n");
}

export function renderPortfolio(svc: Service): string {
  const o = svc.overview();
  const out: string[] = ["# Tunadesk portfolio", ""];
  const s = o.by_status;
  out.push(
    `Tasks: ${s.in_progress ?? 0} in progress · ${(s.review ?? 0) + (s.testing ?? 0)} in review/testing · ${s.blocked ?? 0} blocked · ${s.todo ?? 0} todo · ${o.overdue} overdue · ${o.done_this_week} done this week`,
  );
  out.push("");
  out.push("## Projects");
  for (const p of o.projects) {
    out.push(`- **${p.key}** ${p.name} [${p.status}·${p.priority}] ${p.open_tasks}/${p.total_tasks} open${p.owner ? ` · owner @${p.owner}` : ""}`);
    if (p.description) out.push(`  ${truncate(p.description, 200)}`);
  }
  out.push("");
  out.push("## Agents");
  for (const a of o.actors) {
    const b = o.budgets.find((x) => x.actor === a.id);
    out.push(`- @${a.id} ${a.name} (${a.kind === "human" ? "human" : `${a.platform}, ${a.role}`}) — ${a.status}${a.status_note ? `: ${a.status_note}` : ""}${b ? ` · ${budgetLine(b)}` : ""}`);
  }
  out.push("");
  out.push("## In flight");
  out.push(o.in_progress.length ? o.in_progress.map((t) => taskLine(t)).join("\n") : "_Nothing in flight._");
  out.push("");
  out.push("## Recent decisions");
  out.push(o.recent_decisions.length ? o.recent_decisions.map(decisionLine).join("\n") : "_None._");
  out.push("");
  out.push("## Recent activity");
  out.push(o.activity.slice(0, 15).map(activityLine).join("\n") || "_Quiet._");
  return out.join("\n");
}

export function activityLine(a: Activity): string {
  return `- ${a.created_at.slice(5, 16).replace("T", " ")} ${a.actor ? `@${a.actor} ` : ""}${a.summary}`;
}

export function renderBoard(svc: Service, ref: string, opts: { include_closed?: boolean } = {}): string {
  const p = svc.project(ref);
  const groups = svc.groups(p.id);
  const tasks = svc.listTasks({ project: p.id, include_closed: opts.include_closed });
  const out: string[] = [`# ${p.key} · ${p.name}`, `Status: ${p.status} · Priority: ${p.priority}${p.owner ? ` · Owner: @${p.owner}` : ""}`];
  if (p.repo_path || p.repo_url) out.push(`Repo: ${[p.repo_path, p.repo_url].filter(Boolean).join(" · ")}`);
  if (p.description) out.push("", p.description);
  out.push("", "## Brief (project memory)");
  if (p.brief_as_of) out.push(`_Knowledge as of ${p.brief_as_of.slice(0, 10)} · by @${p.brief_by ?? "?"}${p.brief_evidence ? ` · ${p.brief_evidence}` : ""}${p.locked_to ? ` · maintained by @${p.locked_to}` : ""}_`);
  out.push(p.brief || "_Empty. Agents: keep this updated with goals, architecture and conventions._");
  const notes = svc.briefNotes(p.id);
  if (notes.length) {
    out.push("", `### Notes waiting to be merged into the brief (${notes.length})`);
    for (const n of notes) out.push(`- _(${n.id}) @${n.author ?? "?"}${n.as_of ? `, as of ${n.as_of.slice(0, 10)}` : ""}${n.evidence ? `, ${n.evidence}` : ""}:_ ${n.body.replace(/\s+/g, " ")}`);
    out.push("_If you maintain this brief: fold the still-true parts in with update_project and pass their ids as merged_notes._");
  }
  for (const g of groups) {
    const gt = tasks.filter((t) => t.group_id === g.id && !t.parent_id);
    out.push("", `## ${g.name} (${gt.length})`);
    for (const t of gt) {
      out.push(taskLine(t));
      for (const s of tasks.filter((x) => x.parent_id === t.id)) out.push("  " + taskLine(s));
    }
    if (!gt.length) out.push("_Empty._");
  }
  const loose = tasks.filter((t) => !t.group_id && !t.parent_id);
  if (loose.length) out.push("", "## Ungrouped", ...loose.map((t) => taskLine(t)));
  const decisions = svc.decisions({ project: p.id, limit: 10 });
  out.push("", "## Decisions", decisions.length ? decisions.map(decisionLine).join("\n") : "_None._");
  return out.join("\n");
}

export function renderTask(svc: Service, ref: string): string {
  const t = svc.task(ref);
  const p = svc.project(t.project_id);
  const comments = svc.comments(t.key);
  const subtasks = svc.listTasks({ parent: t.id, include_closed: true });
  const decisions = svc.decisions({ task: t.id });
  const out: string[] = [
    `# ${t.key} · ${t.title}`,
    `Project: ${p.key} ${p.name} · Status: ${t.status} · Priority: ${t.priority} · Type: ${t.type}`,
    `Assignee: ${t.assignee ? "@" + t.assignee : "nobody"} · Reporter: ${t.reporter ? "@" + t.reporter : "—"}${t.lease_holder ? ` · Claimed by @${t.lease_holder} until ${t.lease_expires_at}` : ""}`,
  ];
  const extra: string[] = [];
  if (t.parent_key) extra.push(`Parent: ${t.parent_key}`);
  if (t.due_at) extra.push(`Due: ${t.due_at.slice(0, 10)}`);
  if (t.estimate_tokens || t.tokens_used) extra.push(`Tokens: ${fmtTokens(t.tokens_used)} used / ${fmtTokens(t.estimate_tokens)} est`);
  if (t.blocked_by.length) extra.push(`Blocked by: ${t.blocked_by.join(", ")}`);
  if (t.blocks.length) extra.push(`Blocks: ${t.blocks.join(", ")}`);
  if (t.tags.length) extra.push(`Tags: ${t.tags.join(", ")}`);
  if (t.handoff_count) extra.push(`Handoffs: ${t.handoff_count}`);
  if (extra.length) out.push(extra.join(" · "));
  if (p.repo_path) out.push(`Repo: ${p.repo_path}`);
  out.push("", "## Description", t.description || "_No description._");
  if (subtasks.length) out.push("", "## Sub-tasks", ...subtasks.map((s) => taskLine(s)));
  if (decisions.length) out.push("", "## Decisions", ...decisions.map(decisionLine));
  out.push("", `## Updates (${comments.length})`);
  out.push(comments.length ? comments.slice(-25).map(commentBlock).join("\n\n") : "_No updates yet._");
  return out.join("\n");
}

function commentBlock(c: Comment): string {
  return `**@${c.author ?? "system"}** · ${c.kind} · ${c.created_at.slice(0, 16).replace("T", " ")}\n${c.body}`;
}

export function renderTaskList(tasks: Task[]): string {
  if (!tasks.length) return "_No matching tasks._";
  return tasks.map((t) => taskLine(t)).join("\n");
}

export function renderDecisions(list: Decision[]): string {
  if (!list.length) return "_No decisions._";
  return list
    .map(
      (d) =>
        `### ${d.ref} · ${d.title} (${d.status})\n${d.task_key ? `Task: ${d.task_key} · ` : ""}By @${d.author ?? "unknown"} on ${d.created_at.slice(0, 10)}\n` +
        [d.context && `**Context:** ${d.context}`, `**Decision:** ${d.decision}`, d.rationale && `**Why:** ${d.rationale}`, d.alternatives && `**Alternatives:** ${d.alternatives}`]
          .filter(Boolean)
          .join("\n"),
    )
    .join("\n\n");
}

/** First-session intake: how an agent brings its projects and tasks onto the desk without duplicating anyone. */
export function renderOnboarding(svc: Service, actorId: string): string {
  const me = svc.actor(actorId);
  const projects = svc.listProjects({ include_archived: true });
  const teammates = svc.listActors().filter((a) => a.id !== me.id);
  const mine = svc.listTasks({ assignee: me.id, include_closed: true, limit: 500 });
  const out: string[] = [
    `# Tunadesk onboarding for @${me.id} (${me.name})`,
    "",
    "Goal: put everything you are working on onto the shared desk **once** — no duplicate projects, no duplicate tasks —",
    "and connect your work to what other agents already registered. Work through the steps in order.",
    "",
    "## What is already on the desk",
    projects.length
      ? projects.map((p) => `- **${p.key}** ${p.name}${p.repo_url ? ` · ${p.repo_url}` : ""}${p.repo_path ? ` · ${p.repo_path}` : ""} — ${p.open_tasks} open / ${p.total_tasks} tasks`).join("\n")
      : "_No projects yet — you are the first._",
    "",
    `Teammates: ${teammates.map((t) => `@${t.id} (${t.kind === "human" ? "human" : `${t.platform}, ${t.role}`})`).join(", ") || "none yet"}`,
    `You already own ${mine.length} task(s) here.`,
    "",
    "## Step 1 — Projects",
    "For every project you work on (look at your repos, your memory, your current context):",
    "1. Find it in the list above. Match by git remote first (`git remote get-url origin`), then folder name, then name.",
    "2. If it is missing, call `create_project` with `name`, `repo_url` (the git remote) and `repo_path` (your local checkout).",
    "   The desk returns the existing project instead of creating a twin when the remote, folder or name match — that is expected.",
    "3. Work out how current your knowledge of the project is: the date of your last session/conversation on it, or of the",
    "   latest commit you know (`git log -1 --format=%cs`). That date is your **as_of**. Different agents know different things —",
    "   the desk lets the most recent knowledge win.",
    "4. Brief: if the project has none, write one with `update_project` (goal, stack, how to run/test, conventions) and pass",
    "   `as_of` + `evidence`. If it has one, read it (`project_board` shows its as-of date). Replace it only if your as_of is newer;",
    "   otherwise — or if the desk refuses with stale_knowledge — add what is missing with `add_brief_note`.",
    "",
    "## Step 2 — Tasks",
    "For each open piece of work you know about (TODOs you track, open issues you own, unfinished work in your context):",
    "1. `create_task` in the right project, assigned to yourself (`assignee: \"" + me.id + "\"`), with a short description and realistic priority.",
    "2. If the desk answers **possible_duplicate**, read the suggested tasks (`get_task`). If it is the same work:",
    "   - do NOT create it again;",
    "   - `comment` on the existing task with what you know or have done, and @mention its owner — this is now shared work;",
    "   - if you are actively doing it and it is unowned, `claim_task` it.",
    "   Only if it is genuinely different, call `create_task` again with `force: true`.",
    "3. Link dependencies with `update_task` (`blocked_by`) when one task waits on another.",
    "   When you set a status from memory (e.g. you believe something is done), pass `as_of`; if the desk says the status",
    "   changed after your knowledge, leave it and `comment` instead.",
    "4. Do not import finished work, except as a one-line note in the project brief if it matters for context.",
    "",
    "## Step 3 — Decisions",
    "Log the 2–5 most important past decisions per project with `log_decision` (context, decision, why, alternatives).",
    "Check `list_decisions` first so you don't log one that is already there.",
    "",
    "## Step 4 — Report",
    "Call `onboarding_report` with a short summary: projects found vs. created, tasks created, tasks you joined (with keys),",
    "and anything the human should decide (e.g. two projects that might be one).",
    "",
    "_Be conservative: when unsure whether two things are the same, prefer commenting on the existing one and flagging it in your report._",
  ];
  return out.join("\n");
}

export function renderInbox(list: Notification[]): string {
  return list.length ? list.map(notificationLine).join("\n") : "_Inbox zero._";
}
