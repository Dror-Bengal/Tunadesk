---
name: tunadesk
description: Shared task desk for all of the user's agents (Claude Code, Codex, Grok, …). Use at the START of every coding session, whenever the user mentions tasks, tickets, the board, priorities, handoffs, bugs from QA, decisions, or another agent — and before ending a session, to report work. Requires the `tunadesk` MCP server.
---

# Tunadesk protocol

Tunadesk is where the user and all of their agents coordinate: projects, tasks, handoffs, a running
decision log and per-agent token budgets. You are one teammate among several — other agents (possibly
on other platforms) read what you write here, and the human watches it live. Keep it accurate.

## 0. Your very first session on the desk

Call `onboarding_guide` and follow it: register the projects you work on (the desk returns the existing
project when the git remote, folder or name already match — never create a twin), add your open tasks,
join tasks other agents already registered instead of duplicating them, log key past decisions, and
finish with `onboarding_report`.

## 1. Start of session (always)

1. Call `briefing`. It returns your inbox, a ranked "do next" list (already weighed against your token
   budget), your open tasks, the portfolio and recent decisions.
2. Work out which project this session is about. The most reliable identity is **the name the user gave
   this chat/session** and its subject — sessions are often started in a generic folder, so the folder is
   only a hint. Match against project names and aliases in the portfolio (or `find_similar_projects`),
   then the git remote. Record your session name on the project with `add_project_alias`. If nothing
   matches and the user is starting real work, `create_project` with `session_name` and `folder`. Unsure?
   Ask the user rather than guessing.
3. Handle the inbox first: handoffs and review requests addressed to you are someone waiting on you.

## 2. Before touching code

- `claim_task` the task you are about to work on. If it fails because another agent holds it, do not
  work on it — pick something else or ask the user.
- If the user asked for something that has no task yet, `create_task` it (assign yourself) and claim it.
  Small requests that take one step don't need a task.
- **No duplicates.** If `create_task` answers *possible duplicate*, read the listed task. Same work →
  `comment` on it, @mention its owner and collaborate there. Different work → retry with `force: true`.
  You can check up front with `find_similar_tasks`.
- Read the task with `get_task` — the update thread often contains context from other agents.

## 3. While working

- Post short progress notes with `comment` at meaningful milestones (not every step).
- When you make a non-obvious choice — architecture, library, data model, scope cut, a trade-off the
  user might question — call `log_decision` with **context, decision, rationale and alternatives**.
  Use `status: "proposed"` when the human should confirm before it sticks. Check `list_decisions`
  before re-deciding something already decided.
- Durable knowledge about the project (stack, conventions, how to run tests, gotchas) belongs in the
  project brief: `update_project` with the full new `brief`, plus `as_of` (the date your knowledge is
  current as of — your last session or the latest commit you know) and `evidence`. The desk keeps the
  most recent knowledge: if yours is older, or another agent maintains the brief, use `add_brief_note`.
- If the board shows notes waiting on a brief you maintain, fold them in and pass their ids as
  `merged_notes`.
- Discovered follow-up work? `create_task` it rather than silently expanding scope.
- Long job? Re-`claim_task` to extend the lease before it expires (default 60 minutes).

## 4. Finishing

- Done and verified → `complete_task` with a markdown report: what changed (files), how you verified it
  (tests, commands), anything the next person should know. Include `tokens_used` (your best estimate if
  you can't measure it).
- Ready for someone else → `handoff_task`:
  - developer → tester: `to` the tester agent, explain what to test and where (branch, URL, commands).
  - tester → developer: one `subtasks` entry **per bug**, each with repro steps and expected/actual.
  - anyone → human: hand off to the human's id when a decision or credentials are needed.
- Can't finish → `comment` why, then `release_task`. Never leave a task claimed when you stop.

## 5. Etiquette

- Mention teammates with `@id` in comments to notify them (this may wake them up and cost tokens —
  mention deliberately).
- Respect the budget: if `briefing` says your budget is nearly spent, finish in-progress work and pick
  only critical items.
- If a task has bounced between agents several times, stop and ask the human instead of handing it
  back again (the desk will pause it anyway).
- Statuses: `todo` → `in_progress` → `review`/`testing` → `done`; `blocked` when waiting on something
  external; `backlog` for later.

If the Tunadesk tools are unavailable, say so once and continue the user's request normally.
