// Copy-paste setup snippets for connecting each kind of agent to the desk.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the built CLI (used by stdio MCP bridges). */
export function cliPath(): string {
  const candidates = [resolve(here, "cli", "index.js"), resolve(here, "..", "dist", "cli", "index.js")];
  return candidates.find(existsSync) ?? candidates[0];
}

/** Where the bundled skill / instruction files live (repo checkout or npm package). */
export function skillsDir(): string {
  const candidates = [resolve(here, "..", "skills"), resolve(here, "..", "..", "skills"), resolve(here, "..", "..", "..", "skills")];
  return candidates.find((c) => existsSync(join(c, "claude-code"))) ?? candidates[0];
}

export interface Snippet {
  id: string;
  title: string;
  description: string;
  language: "bash" | "toml" | "json" | "markdown";
  code: string;
}

export function connectSnippets(opts: { deskUrl: string; agentId: string; token?: string }): Snippet[] {
  const url = opts.deskUrl.replace(/\/$/, "");
  const token = opts.token ?? "<AGENT_TOKEN>";
  const cli = cliPath();
  const skills = skillsDir();
  const stdioJson = JSON.stringify(
    { mcpServers: { tunadesk: { command: "node", args: [cli, "mcp"], env: { TUNADESK_URL: url, TUNADESK_TOKEN: token } } } },
    null,
    2,
  );
  return [
    {
      id: "claude-code",
      title: "Claude Code",
      description: "Register the MCP server (user scope = every project), then install the Tunadesk skill so Claude follows the protocol.",
      language: "bash",
      code: [
        `claude mcp add --scope user --transport http tunadesk ${url}/mcp --header "Authorization: Bearer ${token}"`,
        `mkdir -p ~/.claude/skills && cp -R "${join(skills, "claude-code", "tunadesk")}" ~/.claude/skills/`,
      ].join("\n"),
    },
    {
      id: "claude-hook",
      title: "Claude Code — automatic briefing (optional)",
      description: "Add to ~/.claude/settings.json so every Claude Code session starts with the desk briefing in context.",
      language: "json",
      code: JSON.stringify(
        {
          env: { TUNADESK_URL: url, TUNADESK_TOKEN: token },
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node ${JSON.stringify(cli).slice(1, -1)} briefing` }] }] },
        },
        null,
        2,
      ),
    },
    {
      id: "codex",
      title: "OpenAI Codex CLI",
      description: "Append to ~/.codex/config.toml, then add the AGENTS.md block to your repos (or ~/.codex/AGENTS.md for all of them).",
      language: "toml",
      code: [
        "[mcp_servers.tunadesk]",
        'command = "node"',
        `args = [${JSON.stringify(cli)}, "mcp"]`,
        `env = { TUNADESK_URL = ${JSON.stringify(url)}, TUNADESK_TOKEN = ${JSON.stringify(token)} }`,
        "",
        `# then: cat "${join(skills, "codex", "AGENTS.md")}" >> ~/.codex/AGENTS.md`,
      ].join("\n"),
    },
    {
      id: "grok",
      title: "Grok CLI / Cursor / any MCP client (stdio)",
      description: "Most MCP clients accept this mcpServers block (Grok CLI .grok/settings.json, Cursor ~/.cursor/mcp.json, Claude Desktop…). Pair it with skills/generic/SYSTEM_PROMPT.md.",
      language: "json",
      code: stdioJson,
    },
    {
      id: "http",
      title: "Remote MCP (Streamable HTTP)",
      description: "For clients that speak MCP over HTTP. Needs a reachable URL (deploy Tunadesk or tunnel it) when the agent runs in the cloud.",
      language: "json",
      code: JSON.stringify({ mcpServers: { tunadesk: { type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    },
    {
      id: "chat",
      title: "Chat bots without MCP (paste into instructions)",
      description: "For bots that can only call HTTP (custom GPTs, Grok bots, n8n). They use the REST API and markdown views.",
      language: "markdown",
      code: [
        `You are @${opts.agentId} on Tunadesk, the shared task desk of this human's agents.`,
        `API: ${url} — send header "Authorization: Bearer ${token}". Read ${url}/llms.txt for endpoints.`,
        `Start every session with GET ${url}/api/briefing.md. Claim tasks before working (POST /api/tasks/KEY/claim),`,
        `post updates (POST /api/tasks/KEY/comments), log decisions (POST /api/decisions), and finish with`,
        `POST /api/tasks/KEY/complete or /handoff. Always report tokens_used.`,
      ].join("\n"),
    },
    {
      id: "onboarding",
      title: "First session — send this to the agent",
      description: "After connecting, paste this as the agent's first message. It registers its projects and tasks without duplicating what other agents already added.",
      language: "markdown",
      code: [
        `You are now connected to Tunadesk as @${opts.agentId} — the shared task desk for all of my agents.`,
        "Call the tunadesk `onboarding_guide` tool and follow it step by step: register the projects you work on",
        "(reuse existing ones), add your open tasks (join existing tasks instead of duplicating them), log the key",
        "past decisions, then send me a summary with `onboarding_report`. Work carefully — other agents are doing",
        "the same, one after another.",
        `(No MCP? Read ${url}/api/onboarding.md with header "Authorization: Bearer ${token}".)`,
      ].join("\n"),
    },
    {
      id: "runner",
      title: "Wake-ups on the agent's computer (tunadesk runner)",
      description:
        "Run this on the computer where the agent lives (needs Node 22 and a Tunadesk checkout). It keeps a connection to the desk and launches the agent locally when it is woken. Map each project to its local folder with --repo; --save remembers the settings in ~/.tunadesk/runner.json.",
      language: "bash",
      code: [
        "git clone https://github.com/Dror-Bengal/Tunadesk.git ~/tunadesk && cd ~/tunadesk && npm install && npm run build",
        `node ~/tunadesk/server/dist/cli/index.js runner --url ${url} --token ${token} --repo KEY=/path/to/checkout --save`,
        "# keep it running in the background and start at login (macOS):",
        "node ~/tunadesk/server/dist/cli/index.js runner install",
      ].join("\n"),
    },
    {
      id: "curl",
      title: "Smoke test",
      description: "Check the token works.",
      language: "bash",
      code: `curl -s -H "Authorization: Bearer ${token}" ${url}/api/briefing.md`,
    },
  ];
}
