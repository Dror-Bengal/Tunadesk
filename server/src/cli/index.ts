#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cpSync, existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer, bootstrap, VERSION } from "../server.js";
import { openDb } from "../db/index.js";
import { Service } from "../service.js";
import { createMcpServer, type DeskCall } from "../mcp/server.js";
import { connectSnippets, skillsDir } from "../connect.js";
import { PLATFORMS, ROLES, TRIGGER_TYPES, type TriggerType } from "../domain.js";
import { seedDemo } from "./seed.js";

const HELP = `🐟 Tunadesk ${VERSION} — a shared task desk for AI agents and their human

Usage: tunadesk <command> [options]

Commands
  serve                      Start the desk (web UI + REST + MCP + runner)   [default]
      --port <n>             Port (env TUNADESK_PORT, default 4545)
      --host <addr>          Bind address (env TUNADESK_HOST, default 127.0.0.1)
      --db <file>            SQLite file (env TUNADESK_DB, default ~/.tunadesk/tunadesk.db)
      --public-url <url>     URL agents should use (env TUNADESK_PUBLIC_URL)
      --no-runner            Do not wake agents automatically
      --owner <name>         Your display name on first run

  mcp                        Stdio MCP bridge for agents (env TUNADESK_URL, TUNADESK_TOKEN)
  briefing                   Print the caller's briefing (for SessionStart hooks; silent if the desk is down)

  agent add <id>             Register an agent and print its token + setup snippets
      --name, --platform (${PLATFORMS.join("|")}),
      --role (${ROLES.join("|")}), --budget <tokens>, --period day|week|month,
      --trigger (${TRIGGER_TYPES.join("|")})
  agent list                 List agents
  agent token <id>           Issue a new token (revokes the old one)
  connect <id>               Print setup snippets for an agent

  skill install <platform>   Install the protocol for claude-code (skill) or codex (AGENTS.md)
  seed                       Load demo projects, agents and a dev ⇄ QA handoff story

Environment
  TUNADESK_ADMIN_TOKEN       Require this token for the web UI (mandatory when not bound to localhost)
`;

function dbPath(flag?: string) {
  return resolve(flag ?? process.env.TUNADESK_DB ?? join(homedir(), ".tunadesk", "tunadesk.db"));
}

function openService(flag?: string) {
  const svc = new Service(openDb(dbPath(flag)));
  bootstrap(svc);
  return svc;
}

function deskUrlFor(values: { "public-url"?: string; port?: string }) {
  return (values["public-url"] ?? process.env.TUNADESK_PUBLIC_URL ?? `http://127.0.0.1:${values.port ?? process.env.TUNADESK_PORT ?? 4545}`).replace(/\/$/, "");
}

function printSnippets(deskUrl: string, agentId: string, token?: string) {
  for (const s of connectSnippets({ deskUrl, agentId, token })) {
    console.log(`\n── ${s.title} ──\n${s.description}\n\n${s.code}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      db: { type: "string" },
      "public-url": { type: "string" },
      "no-runner": { type: "boolean" },
      owner: { type: "string" },
      name: { type: "string" },
      platform: { type: "string" },
      role: { type: "string" },
      budget: { type: "string" },
      period: { type: "string" },
      trigger: { type: "string" },
      url: { type: "string" },
      token: { type: "string" },
      dir: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || command === "help") {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "serve": {
      startServer({
        dbPath: dbPath(values.db),
        port: Number(values.port ?? process.env.TUNADESK_PORT ?? 4545),
        host: values.host ?? process.env.TUNADESK_HOST ?? "127.0.0.1",
        adminToken: process.env.TUNADESK_ADMIN_TOKEN || undefined,
        ownerName: values.owner,
        runner: !values["no-runner"] && process.env.TUNADESK_RUNNER !== "off",
        publicUrl: values["public-url"] ?? process.env.TUNADESK_PUBLIC_URL,
      });
      return;
    }

    case "mcp": {
      const url = (values.url ?? process.env.TUNADESK_URL ?? "http://127.0.0.1:4545").replace(/\/$/, "");
      const token = values.token ?? process.env.TUNADESK_TOKEN;
      if (!token) console.error("[tunadesk mcp] TUNADESK_TOKEN is not set — requests will only work against a local desk, acting as the owner.");
      const call: DeskCall = async (method, path, body) => {
        const headers: Record<string, string> = {};
        if (token) headers.authorization = `Bearer ${token}`;
        if (body !== undefined) headers["content-type"] = "application/json";
        const res = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, text: await res.text() };
      };
      const server = createMcpServer(call, VERSION);
      await server.connect(new StdioServerTransport());
      return;
    }

    case "briefing": {
      const url = (values.url ?? process.env.TUNADESK_URL ?? "http://127.0.0.1:4545").replace(/\/$/, "");
      const token = values.token ?? process.env.TUNADESK_TOKEN;
      try {
        const res = await fetch(`${url}/api/briefing.md`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(4000) });
        if (res.ok) console.log(await res.text());
      } catch {
        /* the desk is optional: never break the agent's session */
      }
      return;
    }

    case "agent": {
      const sub = positionals[0];
      const svc = openService(values.db);
      if (sub === "list") {
        for (const a of svc.listActors()) {
          const b = svc.budget(a.id);
          console.log(`${a.emoji} ${a.id.padEnd(20)} ${a.kind.padEnd(6)} ${a.platform.padEnd(12)} ${a.role.padEnd(11)} ${a.status.padEnd(8)} ${b.budget ? `${b.used}/${b.budget} per ${b.period}` : ""}`);
        }
        return;
      }
      if (sub === "add") {
        const id = positionals[1];
        if (!id) throw new Error("Usage: tunadesk agent add <id> [--name ...]");
        const trigger = values.trigger as TriggerType | undefined;
        if (trigger && !TRIGGER_TYPES.includes(trigger)) throw new Error(`--trigger must be one of ${TRIGGER_TYPES.join(", ")}`);
        const { actor, token } = svc.createActor({
          id,
          name: values.name ?? id,
          platform: (values.platform as never) ?? "other",
          role: (values.role as never) ?? "developer",
          token_budget: values.budget ? Number(values.budget) : 0,
          budget_period: (values.period as never) ?? "day",
          trigger: trigger ? { type: trigger, enabled: trigger !== "none" } : undefined,
        });
        console.log(`Created @${actor.id}. Token (shown once): ${token}`);
        printSnippets(deskUrlFor(values), actor.id, token);
        return;
      }
      if (sub === "token") {
        const id = positionals[1];
        const token = svc.rotateToken(id);
        console.log(`New token for @${id} (old one revoked): ${token}`);
        return;
      }
      throw new Error("Usage: tunadesk agent add|list|token");
    }

    case "connect": {
      const id = positionals[0];
      if (!id) throw new Error("Usage: tunadesk connect <agent-id> [--token ...]");
      printSnippets(deskUrlFor(values), id, values.token);
      return;
    }

    case "skill": {
      const [sub, platform] = positionals;
      if (sub !== "install" || !platform) throw new Error("Usage: tunadesk skill install claude-code|codex [--dir <path>]");
      const src = skillsDir();
      if (platform === "claude-code" || platform === "claude") {
        const target = resolve(values.dir ?? join(homedir(), ".claude", "skills"), "tunadesk");
        mkdirSync(target, { recursive: true });
        cpSync(join(src, "claude-code", "tunadesk"), target, { recursive: true });
        console.log(`Installed Claude Code skill → ${target}`);
      } else if (platform === "codex") {
        const target = resolve(values.dir ?? join(homedir(), ".codex"), "AGENTS.md");
        const block = readFileSync(join(src, "codex", "AGENTS.md"), "utf8");
        if (existsSync(target) && readFileSync(target, "utf8").includes("<!-- tunadesk -->")) {
          console.log(`${target} already contains the Tunadesk block.`);
        } else {
          mkdirSync(resolve(target, ".."), { recursive: true });
          appendFileSync(target, `\n${block}\n`);
          console.log(`Appended Tunadesk protocol → ${target}`);
        }
      } else {
        throw new Error("Supported: claude-code, codex. For other agents use skills/generic/SYSTEM_PROMPT.md.");
      }
      return;
    }

    case "seed": {
      const svc = openService(values.db);
      const tokens = seedDemo(svc);
      console.log("Seeded demo data. Agent tokens (shown once):");
      for (const [id, token] of Object.entries(tokens)) console.log(`  @${id.padEnd(16)} ${token}`);
      return;
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`tunadesk: ${err.message}`);
  process.exit(1);
});
