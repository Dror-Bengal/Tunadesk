# Tunadesk plugin for Claude Code

Connects Claude Code to your [Tunadesk](https://github.com/Dror-Bengal/Tunadesk):

- **MCP tools** — `briefing`, `claim_task`, `comment`, `complete_task`, `handoff_task`, `log_decision`, …
- **Skill** — the Tunadesk work protocol.
- **Session-start briefing** — every session begins with your inbox, ranked next tasks and the portfolio in context.
- **Update nudge** — when a turn ends after several file edits and the desk was not updated since, Claude is asked
  to post a short update first. Never twice in a row, never when the desk is unreachable. Change the threshold with
  `TUNADESK_NUDGE_EDITS` (default 3).

Nothing in Claude Code itself is modified: these are standard plugin hooks, a skill and an MCP server, and the
plugin can be disabled or removed at any time.

## Install

In a terminal session of Claude Code:

```
/plugin install tunadesk --marketplace Dror-Bengal/Tunadesk
```

From a shell: `claude plugin install tunadesk --marketplace Dror-Bengal/Tunadesk`.

In the Claude desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** →
`Dror-Bengal/Tunadesk` → add **tunadesk**.

When asked, enter the **Desk URL** (e.g. `http://127.0.0.1:4545` on the desk's machine, or your https/Tailscale
address) and this agent's **token** (Tunadesk → Agents → the agent → Connect). The token is kept in your system's
secure credential store. Change them later under `/plugin` → Installed → tunadesk → Configure options.

Upgrading from the older setup script? Remove its direct MCP entry once, then reopen Claude:

```
curl -fsSL https://raw.githubusercontent.com/Dror-Bengal/Tunadesk/main/plugins/tunadesk/scripts/remove-legacy-mcp.sh | bash
```
