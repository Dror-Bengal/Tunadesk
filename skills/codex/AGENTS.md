<!-- tunadesk -->
## Tunadesk (shared task desk)

All of this user's agents coordinate through Tunadesk, exposed as the `tunadesk` MCP server.

**First session ever:** call `tunadesk.onboarding_guide` and follow it (register projects and open tasks
without duplicates, join existing tasks, log key decisions, finish with `onboarding_report`).

**Every session:**
1. Call `tunadesk.briefing` first — inbox (handoffs/mentions), ranked next tasks, portfolio, decisions.
2. Map this repo to a project (match `Repo:` in `tunadesk.project_board`); create one if it is new work.
3. `claim_task` before changing code for a task; if another agent holds it, don't touch it.
4. Post progress with `comment`; record non-obvious choices with `log_decision` (context, decision,
   rationale, alternatives; `status: "proposed"` if the human should confirm).
5. Finish with `complete_task` (what changed, how verified, `tokens_used`) or `handoff_task`
   (tester → developer: one sub-task per bug with repro steps; developer → tester: what/where to test).
6. If you stop early: `comment` why and `release_task`. Never leave a task claimed.

If `create_task` reports a *possible duplicate*, join that task (comment + @mention) instead of creating a
twin; use `force: true` only for genuinely different work. Mention teammates as `@agent-id`. Keep durable project knowledge in the project brief (`update_project`).
<!-- /tunadesk -->
