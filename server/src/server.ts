import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db/index.js";
import { Service } from "./service.js";
import { createApp } from "./api/app.js";
import { createMcpServer, type DeskCall } from "./mcp/server.js";
import { Runner } from "./runner/runner.js";
import { cliPath } from "./connect.js";

const here = dirname(fileURLToPath(import.meta.url));

export const VERSION: string = (() => {
  for (const p of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      if (pkg.name === "tunadesk") return pkg.version;
    } catch {
      /* keep looking */
    }
  }
  return "0.0.0";
})();

export interface ServeOptions {
  dbPath: string;
  port: number;
  host: string;
  adminToken?: string;
  ownerName?: string;
  runner: boolean;
  /** URL agents use to reach this desk; defaults to http://127.0.0.1:<port>. */
  publicUrl?: string;
  webDir?: string;
  quiet?: boolean;
  runnerDebounceMs?: number;
}

/** First boot: make sure the human owner exists. */
export function bootstrap(svc: Service, ownerName = "Me") {
  const ownerId = svc.settings().owner;
  if (!svc.findActor(ownerId)) {
    svc.createActor({ id: ownerId, name: ownerName, kind: "human", emoji: "🧑‍💻", color: "#8c4a2f", issue_token: false });
  }
}

export function buildDesk(svc: Service, opts: { adminToken?: string; trustLocal: boolean; webDir?: string; deskUrl?: string }) {
  // In-process REST calls on behalf of an MCP client; `app` is assigned right below.
  let app: ReturnType<typeof createApp>;
  const callAs =
    (actorId: string): DeskCall =>
    async (method, path, body) => {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      const res = await app.fetch(new Request(`http://tunadesk.internal${path}`, init), { internalActor: actorId });
      return { status: res.status, text: await res.text() };
    };

  app = createApp(svc, {
    adminToken: opts.adminToken,
    trustLocal: opts.trustLocal,
    webDir: opts.webDir,
    deskUrl: opts.deskUrl,
    version: VERSION,
    mcp: async (req, actor) => {
      const server = createMcpServer(callAs(actor.id), VERSION);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const res = await transport.handleRequest(req);
      void server.close();
      return res;
    },
  });
  return app;
}

export function defaultWebDir(): string | undefined {
  const candidates = [join(here, "..", "public"), resolve(here, "..", "..", "web", "dist")];
  return candidates.find((c) => existsSync(join(c, "index.html")));
}

export function startServer(opts: ServeOptions) {
  const db = openDb(opts.dbPath);
  const svc = new Service(db);
  bootstrap(svc, opts.ownerName);
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(opts.host);
  if (!isLoopback && !opts.adminToken) {
    throw new Error(`Refusing to listen on ${opts.host} without TUNADESK_ADMIN_TOKEN — anyone on the network could control your agents.`);
  }
  const deskUrl = (opts.publicUrl ?? `http://127.0.0.1:${opts.port}`).replace(/\/$/, "");
  const app = buildDesk(svc, { adminToken: opts.adminToken, trustLocal: true, webDir: opts.webDir ?? defaultWebDir(), deskUrl });

  const server = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host });

  const leaseTimer = setInterval(() => svc.expireLeases(), 60_000);
  leaseTimer.unref();

  let runner: Runner | null = null;
  if (opts.runner) {
    runner = new Runner(svc, { deskUrl, cliPath: cliPath(), debounceMs: opts.runnerDebounceMs, log: opts.quiet ? () => {} : undefined });
    runner.start();
  }

  if (!opts.quiet) {
    console.log(`\n  🐟 Tunadesk ${VERSION}`);
    console.log(`  ➜ Desk:   http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`);
    console.log(`  ➜ MCP:    ${deskUrl}/mcp`);
    console.log(`  ➜ Data:   ${opts.dbPath}`);
    console.log(`  ➜ Runner: ${runner ? "on" : "off"}\n`);
  }

  const close = () => {
    clearInterval(leaseTimer);
    runner?.stop();
    server.close();
    db.close();
  };
  return { svc, app, server, runner, close, deskUrl };
}
