import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { Service } from "../src/service.js";
import { bootstrap, buildDesk } from "../src/server.js";

const LOCAL = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
let svc: Service;
let app: ReturnType<typeof buildDesk>;
let dev: string;
let qa: string;

function call(path: string, init: { method?: string; token?: string; json?: unknown; headers?: Record<string, string>; body?: string } = {}, env: object = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return app.request(`http://localhost:4545${path}`, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }, env);
}

beforeEach(() => {
  svc = new Service(openDb(":memory:"));
  bootstrap(svc);
  dev = svc.createActor({ id: "dev", name: "Dev", role: "developer" }).token!;
  qa = svc.createActor({ id: "qa", name: "QA", role: "tester", trigger: { type: "webhook", enabled: true, url: "http://x", secret: "hush" } }).token!;
  app = buildDesk(svc, { trustLocal: true });
  svc.createProject({ name: "Web", key: "WEB", repo_path: "/repo" }, "me");
});

describe("browser drive-by protection", () => {
  it("rejects cross-site requests even from loopback", async () => {
    const res = await call(
      "/api/actors",
      { method: "POST", body: JSON.stringify({ name: "evil" }), headers: { origin: "https://evil.example", "content-type": "text/plain" } },
      LOCAL,
    );
    expect(res.status).toBe(403);
    expect(svc.findActor("evil")).toBeNull();
  });

  it("rejects content types that merely mention json", async () => {
    const res = await call("/api/actors", { method: "POST", body: JSON.stringify({ name: "evil" }), headers: { "content-type": "text/plain; x=application/json" } }, LOCAL);
    expect(res.status).toBe(415);
  });

  it("allows same-origin requests from the UI", async () => {
    const res = await call("/api/actors", { method: "POST", json: { name: "Good" }, headers: { origin: "http://localhost:4545" } }, LOCAL);
    expect(res.status).toBe(201);
  });

  it("ignores ?token= on writes", async () => {
    const res = await call(`/api/tasks?token=${dev}`, { method: "POST", json: { project: "WEB", title: "x" } });
    expect(res.status).toBe(401);
  });
});

describe("agent permissions", () => {
  it("never exposes webhook secrets", async () => {
    const list = await (await call("/api/actors", { token: dev })).text();
    expect(list).not.toContain("hush");
    expect(JSON.parse(list).find((a: { id: string }) => a.id === "qa").trigger.has_secret).toBe(true);
    expect(svc.triggerConfig("qa").secret).toBe("hush");
  });

  it("keeps the secret when a human edits other trigger fields", () => {
    svc.updateActor("qa", { trigger: { timeout_minutes: 5 } }, "me");
    expect(svc.triggerConfig("qa").secret).toBe("hush");
  });

  it("lets only humans move a project's repo path or change budget periods", async () => {
    expect((await call("/api/projects/WEB", { method: "PATCH", token: dev, json: { repo_path: "/Users/me" } })).status).toBe(403);
    expect((await call("/api/projects/WEB", { method: "PATCH", token: dev, json: { brief: "ok" } })).status).toBe(200);
    expect((await call("/api/actors/dev", { method: "PATCH", token: dev, json: { budget_period: "day" } })).status).toBe(403);
    expect((await call("/api/projects/WEB", { method: "PATCH", json: { repo_path: "/new" } }, LOCAL)).status).toBe(200);
  });

  it("hides other agents' runs", async () => {
    svc.createRun({ actor: "qa", trigger_type: "webhook", status: "skipped", reason: "x" });
    expect(await (await call("/api/runs?actor=qa", { token: dev })).json()).toEqual([]);
    expect(await (await call("/api/runs", { token: qa })).json()).toHaveLength(1);
  });
});

describe("lease enforcement", () => {
  it("stops other agents from completing, handing off, editing or deleting a claimed task", async () => {
    const t = svc.createTask({ project: "WEB", title: "x" }, "me");
    svc.claim(t.key, "dev");
    expect(() => svc.complete(t.key, "qa", { summary: "mine now" })).toThrow(/claimed by dev/);
    expect(() => svc.handoff(t.key, "qa", { to: "qa", message: "x" })).toThrow(/claimed by dev/);
    expect(() => svc.updateTask(t.key, { status: "done" }, "qa")).toThrow(/claimed by dev/);
    expect(() => svc.deleteTask(t.key, "qa")).toThrow(/claimed by dev/);
    // Humans can always override.
    expect(svc.updateTask(t.key, { priority: "high" }, "me").priority).toBe("high");
  });

  it("refuses to complete a task twice", () => {
    const t = svc.createTask({ project: "WEB", title: "x" }, "me");
    svc.complete(t.key, "dev", { summary: "done" });
    expect(() => svc.complete(t.key, "dev", { summary: "again" })).toThrow(/already done/);
  });
});

describe("loop guard", () => {
  it("counts review requests via complete() and resets when a human steps in", () => {
    svc.setSetting("loop_guard_limit", 2);
    const t = svc.createTask({ project: "WEB", title: "x", assignee: "dev" }, "me");
    svc.complete(t.key, "dev", { summary: "1", status: "testing", next_assignee: "qa" });
    svc.handoff(t.key, "qa", { to: "dev", message: "2" });
    const tripped = svc.handoff(t.key, "dev", { to: "qa", message: "3" });
    expect(tripped.loop_guard).toBe(true);
    expect(tripped.task.status).toBe("blocked");

    const human = svc.handoff(t.key, "me", { to: "qa", message: "try once more" });
    expect(human.loop_guard).toBe(false);
    expect(human.task.handoff_count).toBe(0);
    expect(svc.handoff(t.key, "qa", { to: "dev", message: "ok" }).loop_guard).toBe(false);
  });
});

describe("events", () => {
  it("emits nothing for rolled-back work", async () => {
    const seen: string[] = [];
    svc.events.on("event", (e) => seen.push(e.type));
    const t = svc.createTask({ project: "WEB", title: "x", assignee: "qa" }, "me");
    await Promise.resolve();
    seen.length = 0;
    expect(() => svc.handoff(t.key, "qa", { to: "dev", message: "bugs", subtasks: [{ title: "real" }, { title: "   " }] })).toThrow();
    await Promise.resolve();
    expect(seen).toEqual([]);
    expect(svc.listTasks({ project: "WEB" })).toHaveLength(1);
  });
});

describe("static files", () => {
  it("does not serve sibling directories or crash on bad escapes", async () => {
    const base = join(tmpdir(), `tdk-static-${Date.now()}`);
    mkdirSync(join(base, "web"), { recursive: true });
    mkdirSync(join(base, "web-secret"), { recursive: true });
    writeFileSync(join(base, "web", "index.html"), "<html>ok</html>");
    writeFileSync(join(base, "web-secret", "key.txt"), "SECRET");
    app = buildDesk(svc, { trustLocal: true, webDir: join(base, "web") });
    const leak = await (await app.request("http://localhost:4545/..%2Fweb-secret%2Fkey.txt")).text();
    expect(leak).not.toContain("SECRET");
    expect((await app.request("http://localhost:4545/%E0%A4%A")).status).toBe(400);
  });
});

describe("webhook headers", () => {
  it("stores custom headers as secrets and sends them with the webhook", async () => {
    svc.updateActor("qa", { trigger: { headers: { Authorization: "Bearer grok-key" } } }, "me");
    const list = await (await call("/api/actors", { token: dev })).text();
    expect(list).not.toContain("grok-key");
    expect(JSON.parse(list).find((a: { id: string }) => a.id === "qa").trigger.header_names).toEqual(["Authorization"]);
    expect(svc.triggerConfig("qa").headers).toEqual({ Authorization: "Bearer grok-key" });
    expect(svc.triggerConfig("qa").secret).toBe("hush");
  });
});
