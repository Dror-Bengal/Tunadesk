import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Service } from "../src/service.js";
import { bootstrap, buildDesk } from "../src/server.js";

let svc: Service;
let app: ReturnType<typeof buildDesk>;
let mini: string;
let book: string;

const req = (method: string, path: string, token: string, json?: unknown) =>
  app.request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

beforeEach(() => {
  svc = new Service(openDb(":memory:"));
  bootstrap(svc);
  mini = svc.createActor({ id: "claude-mini", name: "Claude on the Mac mini" }).token!;
  book = svc.createActor({ id: "claude-book", name: "Claude on the MacBook" }).token!;
  app = buildDesk(svc, { trustLocal: true });
  svc.createProject({ name: "Cohen Brothers", key: "COH" }, "me");
});

describe("project briefs keep the most recent knowledge", () => {
  it("lets newer knowledge replace the brief and refuses older knowledge", async () => {
    const first = await req("PATCH", "/api/projects/COH", book, { brief: "v1 from the MacBook", as_of: "2026-10-12", evidence: "session 2026-10-12" });
    expect(first.status).toBe(200);
    expect((await first.json()).brief_as_of.slice(0, 10)).toBe("2026-10-12");

    const newer = await req("PATCH", "/api/projects/COH", mini, { brief: "v2 from the Mac mini", as_of: "2026-10-20", evidence: "commit abc (2026-10-20)" });
    expect(newer.status).toBe(200);

    const stale = await req("PATCH", "/api/projects/COH", book, { brief: "v1 again", as_of: "2026-10-12" });
    expect(stale.status).toBe(409);
    const err = (await stale.json()).error;
    expect(err.code).toBe("stale_knowledge");
    expect(err.message).toMatch(/as of 2026-10-20 \(by @claude-mini, commit abc/);
    expect(svc.project("COH").brief).toBe("v2 from the Mac mini");
  });

  it("requires as_of from agents replacing an existing brief, but not for the first brief", async () => {
    expect((await req("PATCH", "/api/projects/COH", book, { brief: "first" })).status).toBe(200);
    expect((await req("PATCH", "/api/projects/COH", book, { brief: "second" })).status).toBe(400);
    expect((await req("PATCH", "/api/projects/COH", book, { description: "no brief change needs no date" })).status).toBe(200);
  });

  it("always accepts the human and resets the clock to now", () => {
    svc.updateProject("COH", { brief: "agent" }, "claude-mini", { as_of: "2026-10-20" });
    const p = svc.updateProject("COH", { brief: "human edit" }, "me");
    expect(p.brief_by).toBe("me");
    expect(Date.parse(p.brief_as_of!)).toBeGreaterThan(Date.parse("2026-10-21"));
  });

  it("honours a lock set by the human", async () => {
    expect((await req("PATCH", "/api/projects/COH", mini, { locked_to: "claude-mini" })).status).toBe(403);
    svc.updateProject("COH", { locked_to: "claude-mini" }, "me");
    const blocked = await req("PATCH", "/api/projects/COH", book, { brief: "x", as_of: "2099-01-01" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("brief_locked");
    expect((await req("PATCH", "/api/projects/COH", mini, { brief: "maintainer", as_of: "2026-10-20" })).status).toBe(200);
  });

  it("collects notes from less-informed agents and lets the maintainer merge them", async () => {
    svc.updateProject("COH", { brief: "current" }, "claude-mini", { as_of: "2026-10-20" });
    const note = await (await req("POST", "/api/projects/COH/notes", book, { body: "Invoices moved to the new API in September", as_of: "2026-10-12" })).json();
    const board = await (await req("GET", "/api/projects/COH/board.md", mini)).text();
    expect(board).toContain("Knowledge as of 2026-10-20 · by @claude-mini");
    expect(board).toContain(note.id);
    expect(board).toContain("Invoices moved");

    await req("PATCH", "/api/projects/COH", mini, { brief: "current + invoices", as_of: "2026-10-21", merged_notes: [note.id] });
    expect(svc.briefNotes("COH")).toHaveLength(0);
    expect(svc.briefNotes("COH", { include_merged: true })).toHaveLength(1);
  });
});

describe("task statuses respect when they last changed", () => {
  it("refuses a status set from older knowledge, accepts newer or live changes", async () => {
    const t = svc.createTask({ project: "COH", title: "Monthly invoice run" }, "me");
    svc.updateTask(t.key, { status: "done" }, "claude-mini");

    const stale = await req("PATCH", `/api/tasks/${t.key}`, book, { status: "in_progress", as_of: "2026-10-01" });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("stale_knowledge");
    expect(svc.task(t.key).status).toBe("done");

    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await req("PATCH", `/api/tasks/${t.key}`, book, { status: "todo", as_of: future })).status).toBe(200);
    expect((await req("PATCH", `/api/tasks/${t.key}`, book, { status: "in_progress" })).status).toBe(200);
  });

  it("rejects malformed dates", async () => {
    const t = svc.createTask({ project: "COH", title: "x" }, "me");
    expect((await req("PATCH", `/api/tasks/${t.key}`, book, { status: "done", as_of: "last tuesday" })).status).toBe(400);
  });
});

describe("silent tasks", () => {
  it("lists in-progress work with no update for a day, in the owner's overview and the agent's briefing", async () => {
    const t = svc.createTask({ project: "COH", title: "Quiet work", assignee: "claude-mini" }, "me");
    svc.updateTask(t.key, { status: "in_progress" }, "claude-mini");
    svc.db.prepare("UPDATE tasks SET updated_at = ? WHERE key = ?").run(new Date(Date.now() - 50 * 3_600_000).toISOString(), t.key);
    expect(svc.overview().stale.map((x) => x.key)).toEqual([t.key]);
    const brief = await (await req("GET", "/api/briefing.md", mini)).text();
    expect(brief).toMatch(/Waiting for your update \(1\)[\s\S]*Quiet work[\s\S]*no update for 2 days/);
    svc.addComment(t.key, "claude-mini", "still on it");
    expect(svc.staleTasks()).toHaveLength(0);
  });
});
