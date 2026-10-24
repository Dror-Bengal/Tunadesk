# Architecture

```
server/src
├── domain.ts          vocabulary: statuses, priorities, roles, triggers, errors
├── db/index.ts        node:sqlite, WAL, versioned migrations
├── service.ts         ALL business rules (one class, synchronous, transactional)
├── render.ts          compact markdown views for agents
├── api/app.ts         Hono REST API, auth, SSE, static web app, llms.txt
├── mcp/server.ts      MCP tools defined once over REST paths
├── runner/runner.ts   turns notifications into agent runs
├── connect.ts         setup snippets per platform
├── server.ts          wiring: HTTP server, in-process MCP, runner, lease expiry
└── cli/               serve, mcp (stdio bridge), briefing, agent, skill, seed
web/src                React app (no UI kit), hash routing, live data via SSE
skills/                protocol for Claude Code, Codex and any other agent
```

**One rule engine.** `Service` owns every invariant (leases, handoffs, loop guard, budgets,
prioritisation, notifications) inside SQLite transactions. REST, MCP and the runner never touch the
database directly, so behaviour is identical whichever way an agent connects.

**MCP over REST.** MCP tools are defined once against REST paths. Over HTTP (`/mcp`) the calls are
dispatched in-process as the authenticated agent; the stdio bridge (`tunadesk mcp`) sends the same
calls over the network with the agent's token. Tool output is compact markdown to save agent tokens.

**Events.** Every mutation writes an `activity` row and emits it after commit. The web app listens over
SSE (`/api/events`) and refetches; the runner listens for `notification` events that should wake an agent.

**Runner.** Debounces wake-ups per agent (batching related notifications), enforces one active run per
agent, rate limits and budget checks, mints a short-lived token per run, launches the CLI with an argv
array (no shell) in the project's repo, captures the output and records a `run`.

**Auth.** Agents: bearer tokens (SHA-256 hashed at rest). Human: loopback trust when no admin token is
configured (Host header must be local), otherwise `TUNADESK_ADMIN_TOKEN`. Writes must be JSON.

**Data model.** `actors` (humans and agents) · `projects` → `groups` → `tasks` (sub-tasks via
`parent_id`, blockers via `task_links`) · `comments` · `decisions` · `notifications` · `usage` ·
`activity` · `runs` · `settings`.
