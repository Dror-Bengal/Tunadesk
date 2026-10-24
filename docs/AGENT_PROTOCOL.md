# The Tunadesk agent protocol

Tunadesk works because every agent follows the same small protocol, whatever platform it runs on.
The canonical wording for agents lives in [`skills/`](../skills); this page explains the *why*.

## Lifecycle of a task

```
backlog → todo → in_progress → review / testing → done
                     │              │
                     └── blocked ◄──┘        (canceled at any point)
```

| Step | Tool (MCP) | REST | Why |
| ---- | ---------- | ---- | --- |
| Orient | `briefing` | `GET /api/briefing.md` | Inbox, ranked queue, portfolio, decisions in one cheap call |
| Claim | `claim_task` | `POST /api/tasks/K/claim` | A lease (default 60 min) prevents two agents doing the same work. Expired leases are freed automatically |
| Report progress | `comment` | `POST /api/tasks/K/comments` | Humans and agents follow the thread; `@id` notifies |
| Decide | `log_decision` | `POST /api/decisions` | Durable "why"; `proposed` decisions wait for the human |
| Finish | `complete_task` | `POST /api/tasks/K/complete` | Report + `tokens_used`; optional `status: review/testing` + `next_assignee` |
| Pass on | `handoff_task` | `POST /api/tasks/K/handoff` | Re-assigns with context; `subtasks` creates one child per follow-up (e.g. bug) |
| Give up | `release_task` | `POST /api/tasks/K/release` | Frees the lease with a note |

## Handoffs and the loop guard

A handoff sets the new assignee, picks a status from the receiver's role (tester → `testing`,
reviewer → `review`, otherwise `todo`), posts a handoff update and notifies the receiver — which can
wake it through its trigger.

Every handoff increments the task's `handoff_count`. Past the limit (Settings → Guardrails, default 6)
the task is set to `blocked`, stays with its current owner and the human gets a **loop guard**
notification. The runner adds two more brakes: max runs per agent per hour and per task per hour.

## Budgets and prioritisation

Agents report usage with `tokens_used` (on complete/handoff) or `report_usage`. Budgets are per day,
week or month (UTC). Providers don't expose remaining subscription quota, so the desk tracks what agents
report — estimates are fine.

`next_tasks` / the briefing rank work by:

- priority (critical 100, high 60, medium 30, low 10) and project priority
- already in progress (+80) or waiting on your review/testing (+40)
- due dates (overdue +50, < 24h +30, < 3 days +15) and age
- tasks it unblocks (+10 each)
- unassigned tasks whose type matches the agent's role are included
- blocked tasks and tasks leased by others are excluded
- budget: exhausted → critical only; estimate above remaining → strongly demoted; > 80% used → low
  priority deferred

## Mentions and notifications

| Type | When | Wakes agent |
| ---- | ---- | ----------- |
| `assigned` | someone else assigns you | ✓ |
| `mentioned` | `@you` in a description, update or decision; the "wake" button | ✓ |
| `handoff` | a task is handed to you | ✓ |
| `review_request` | `complete_task` with `next_assignee` | ✓ |
| `completed` | a task you reported is done | |
| `comment` | a human posts on your task | |
| `loop_guard`, `budget`, `run_failed` | sent to the human | |

## Writing good updates

- **Report:** what changed (files/areas), how it was verified, what is left, risks.
- **Handoff to tester:** what to test, where (branch/URL/command), what "good" looks like.
- **Handoff to developer:** one sub-task per bug — steps, expected, actual, evidence (failing test path).
- **Decision:** context → decision → why → alternatives. Short beats complete.
