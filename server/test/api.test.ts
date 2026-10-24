import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db/index.js";
import { Service } from "../src/service.js";
import { bootstrap, buildDesk } from "../src/server.js";

let svc: Service;
let app: ReturnType<typeof buildDesk>;
let devToken: string;
let qaToken: string;

const LOCAL = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

function req(path: string, init: RequestInit & { token?: string; json?: unknown } = {}, env: object = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return app.request(`http://localhost:4545${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }, env);
}

beforeEach(() => {
  svc = new Service(openDb(":memory:"));
  bootstrap(svc);
  devToken = svc.createActor({ id: "claude-dev", name: "Claude Dev", platform: "claude-code", role: "developer" }).token!;
  qaToken = svc.createActor({ id: "codex-qa", name: "Codex QA", platform: "codex", role: "tester" }).token!;
  app = buildDesk(svc, { trustLocal: true });
  svc.createProject({ name: "Web", key: "WEB" }, "me");
});

describe("auth", () => {
  it("rejects anonymous remote calls", async () => {
    const res = await req("/api/me");
    expect(res.status).toBe(401);
  });

  it("trusts loopback as the owner when no admin token is set", async () => {
    const res = await req("/api/me", {}, LOCAL);
    expect((await res.json()).actor.id).toBe("me");
  });

  it("does not trust loopback with a foreign Host header (DNS rebinding)", async () => {
    const res = await app.request("http://evil.example/api/me", { headers: { host: "evil.example" } }, LOCAL);
    expect(res.status).toBe(401);
  });

  it("identifies agents by token and keeps them out of admin routes", async () => {
    const me = await (await req("/api/me", { token: devToken })).json();
    expect(me.actor.id).toBe("claude-dev");
    const res = await req("/api/actors", { method: "POST", token: devToken, json: { name: "Rogue" } });
    expect(res.status).toBe(403);
  });

  it("requires the admin token when configured", async () => {
    app = buildDesk(svc, { trustLocal: true, adminToken: "s3cret" });
    expect((await req("/api/me", {}, LOCAL)).status).toBe(401);
    expect((await (await req("/api/me", { token: "s3cret" })).json()).actor.id).toBe("me");
  });

  it("refuses non-JSON writes (CSRF guard)", async () => {
    const res = await req("/api/tasks", { method: "POST", token: devToken, body: "project=WEB&title=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(415);
  });
});

describe("rest workflow", () => {
  it("runs a full dev → QA → dev loop over HTTP", async () => {
    const created = await (await req("/api/tasks", { method: "POST", token: devToken, json: { project: "WEB", title: "Contact form" } })).json();
    expect(created.key).toBe("WEB-1");
    expect(created.reporter).toBe("claude-dev");

    const claimed = await (await req("/api/tasks/WEB-1/claim", { method: "POST", token: devToken })).json();
    expect(claimed.lease_holder).toBe("claude-dev");

    const conflict = await req("/api/tasks/WEB-1/claim", { method: "POST", token: qaToken });
    expect(conflict.status).toBe(409);

    await req("/api/tasks/WEB-1/handoff", { method: "POST", token: devToken, json: { to: "codex-qa", message: "ready", tokens_used: 5000 } });
    const qaBrief = await (await req("/api/briefing.md", { token: qaToken })).text();
    expect(qaBrief).toContain("[handoff] **WEB-1** from @claude-dev");

    const back = await (
      await req("/api/tasks/WEB-1/handoff", { method: "POST", token: qaToken, json: { to: "claude-dev", message: "1 bug", subtasks: [{ title: "Crash on submit" }] } })
    ).json();
    expect(back.subtasks[0].key).toBe("WEB-2");

    const detail = await (await req("/api/tasks/WEB-1", { token: devToken })).json();
    expect(detail.subtasks).toHaveLength(1);
    expect(detail.comments.map((c: { kind: string }) => c.kind)).toEqual(["handoff", "handoff"]);

    const md = await (await req("/api/tasks/WEB-1.md", { token: devToken })).text();
    expect(md).toContain("# WEB-1 · Contact form");
    expect(md).toContain("WEB-2");
  });

  it("validates input with helpful messages", async () => {
    const res = await req("/api/tasks", { method: "POST", token: devToken, json: { project: "WEB", title: "x", priority: "urgent" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/priority/);
  });

  it("lets humans read an agent's inbox but not agents each other's", async () => {
    await req("/api/tasks", { method: "POST", json: { project: "WEB", title: "x", assignee: "codex-qa" } }, LOCAL);
    const asOwner = await (await req("/api/inbox?actor=codex-qa", {}, LOCAL)).json();
    expect(asOwner).toHaveLength(1);
    const asDev = await req("/api/inbox?actor=codex-qa", { token: devToken });
    expect(asDev.status).toBe(403);
  });

  it("serves llms.txt and agent markdown views", async () => {
    expect(await (await req("/llms.txt")).text()).toContain("Tunadesk");
    const board = await (await req("/api/projects/WEB/board.md", { token: devToken })).text();
    expect(board).toContain("## Now");
    const portfolio = await (await req("/api/portfolio.md", { token: devToken })).text();
    expect(portfolio).toContain("**WEB** Web");
  });

  it("wakes an agent with a notification", async () => {
    const res = await (await req("/api/actors/codex-qa/wake", { method: "POST", json: { message: "look at WEB" } }, LOCAL)).json();
    expect(res.ok).toBe(true);
    expect(svc.inbox("codex-qa")[0].type).toBe("mentioned");
  });
});

describe("mcp over http", () => {
  async function connect(token: string) {
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost:4545/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (url, init) => app.request(String(url), init as RequestInit),
    });
    await client.connect(transport);
    return client;
  }

  it("lists tools and runs the protocol as the calling agent", async () => {
    const client = await connect(devToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["briefing", "claim_task", "handoff_task", "complete_task", "log_decision", "comment"]) expect(names).toContain(n);

    const created = await client.callTool({ name: "create_task", arguments: { project: "WEB", title: "Hero", priority: "high" } });
    expect((created.content as Array<{ text: string }>)[0].text).toContain("Created WEB-1");

    const claimed = await client.callTool({ name: "claim_task", arguments: { task: "WEB-1" } });
    expect((claimed.content as Array<{ text: string }>)[0].text).toContain("claimed by @claude-dev");

    await client.callTool({ name: "log_decision", arguments: { project: "WEB", task: "WEB-1", title: "Use Astro", decision: "Astro", rationale: "fast" } });
    const done = await client.callTool({ name: "complete_task", arguments: { task: "WEB-1", summary: "Shipped", tokens_used: 1234 } });
    expect((done.content as Array<{ text: string }>)[0].text).toContain("done");

    const brief = await client.callTool({ name: "briefing", arguments: {} });
    expect((brief.content as Array<{ text: string }>)[0].text).toContain("Tunadesk briefing for @claude-dev");
    expect(svc.budget("claude-dev").used).toBe(1234);
    expect(svc.decisions({ project: "WEB" })[0].author).toBe("claude-dev");
    await client.close();
  });

  it("returns tool errors instead of throwing", async () => {
    const client = await connect(devToken);
    const res = await client.callTool({ name: "claim_task", arguments: { task: "NOPE-9" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/404/);
    await client.close();
  });

  it("rejects MCP calls without a token", async () => {
    const res = await app.request("http://localhost:4545/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });
});
