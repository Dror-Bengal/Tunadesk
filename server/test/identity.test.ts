import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Service } from "../src/service.js";
import { bootstrap, buildDesk } from "../src/server.js";

let svc: Service;
let app: ReturnType<typeof buildDesk>;
let a: string;
let b: string;

const req = (method: string, path: string, token: string, json?: unknown) =>
  app.request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

beforeEach(() => {
  svc = new Service(openDb(":memory:"));
  bootstrap(svc);
  a = svc.createActor({ id: "claude-a", name: "Claude A" }).token!;
  b = svc.createActor({ id: "claude-b", name: "Claude B" }).token!;
  app = buildDesk(svc, { trustLocal: true });
});

describe("projects are identified by session names, not folders", () => {
  it("stores the session name as an alias and finds the project by it next time", async () => {
    const created = await (await req("POST", "/api/projects", a, { name: "Cohen containers", session_name: "מכולות האחים כהן", folder: "/Users/dror" })).json();
    expect(created.aliases).toContain("מכולות האחים כהן");

    const again = await req("POST", "/api/projects", b, { name: "מכולות האחים כהן", folder: "/Users/drorbengal/cohenb" });
    expect(again.status).toBe(200);
    const body = await again.json();
    expect(body.existing).toBe(true);
    expect(body.key).toBe(created.key);
    expect(svc.sources(created.key).map((s) => `${s.actor}:${s.kind}`)).toEqual(expect.arrayContaining(["claude-a:session", "claude-a:folder", "claude-b:folder"]));
  });

  it("does not treat a generic home folder as the project's identity", async () => {
    await req("POST", "/api/projects", a, { name: "Video factory", repo_path: "/Users/dror" });
    const other = await req("POST", "/api/projects", b, { name: "Volunteer CRM", repo_path: "/Users/dror" });
    expect(other.status).toBe(201);
  });

  it("flags look-alike names in Hebrew and English, and accepts force", async () => {
    await req("POST", "/api/projects", a, { name: "מכולות האחים כהן" });
    const dup = await req("POST", "/api/projects", b, { name: "האחים כהן — מכולות" });
    expect(dup.status).toBe(409);
    const err = (await dup.json()).error;
    expect(err.code).toBe("possible_duplicate_project");
    expect(err.message).toMatch(/add_project_alias/);
    expect((await req("POST", "/api/projects", b, { name: "האחים כהן — מכולות", force: true })).status).toBe(201);
  });

  it("lets agents add aliases but only humans replace them", async () => {
    svc.createProject({ name: "Inside You Factory", key: "IYF" }, "me");
    const added = await (await req("PATCH", "/api/projects/IYF", a, { add_aliases: ["the factory", "how-it-works"] })).json();
    expect(added.aliases).toEqual(["the factory", "how-it-works"]);
    expect((await req("PATCH", "/api/projects/IYF", a, { aliases: [] })).status).toBe(403);
  });
});

describe("moving tasks and merging projects", () => {
  beforeEach(() => {
    svc.createProject({ name: "Inside You Factory", key: "IYF", brief: "Factory brief" }, "me");
    svc.createProject({ name: "Schools videos", key: "SCH" }, "me");
  });

  it("moves a task with its sub-tasks; the old key still resolves", async () => {
    const parent = svc.createTask({ project: "IYF", title: "Produce 25 lessons", assignee: "claude-a" }, "me");
    svc.createTask({ project: "IYF", title: "Narration", parent: parent.key }, "me");
    const moved = await (await req("POST", `/api/tasks/${parent.key}/move`, a, { project: "SCH" })).json();
    expect(moved.key).toBe("SCH-1");
    expect(svc.task("IYF-1").key).toBe("SCH-1");
    expect(svc.task("IYF-2").key).toBe("SCH-2");
    expect(svc.task("SCH-2").parent_key).toBe("SCH-1");
    expect(svc.listTasks({ project: "IYF" })).toHaveLength(0);
  });

  it("refuses a duplicate of open work in another project and suggests moving it", async () => {
    svc.createTask({ project: "IYF", title: "Produce the 25 new curriculum lessons" }, "me");
    const dup = await req("POST", "/api/tasks", a, { project: "SCH", title: "Produce the 25 new curriculum lessons" });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.message).toMatch(/IYF-1.*move_task/);
  });

  it("merges a duplicate project into the right one", async () => {
    svc.createProject({ name: "Cohen containers", key: "CONT", brief: "Containers brief" }, "me");
    svc.createProject({ name: "Cohen B", key: "COHE" }, "me");
    svc.createTask({ project: "COHE", title: "Existing COHE task" }, "me");
    const t1 = svc.createTask({ project: "CONT", title: "Invoice import" }, "me");
    svc.logDecision({ project: "COHE", title: "D on COHE", decision: "x" }, "me");
    svc.logDecision({ project: "CONT", title: "D on CONT", decision: "y" }, "me");
    svc.addBriefNote("CONT", "claude-b", { body: "note" });

    const res = await (await req("POST", "/api/projects/CONT/merge", a, { into: "COHE" })).json();
    expect(res.moved_tasks).toEqual([{ from: t1.key, to: "COHE-2" }]);
    expect(svc.task("CONT-1").key).toBe("COHE-2");
    expect(svc.project("CONT").key).toBe("COHE");
    const cohe = svc.project("COHE");
    expect(cohe.brief).toBe("Containers brief");
    expect(cohe.aliases).toContain("Cohen containers");
    expect(svc.decisions({ project: "COHE" }).map((d) => d.ref).sort()).toEqual(["COHE-D1", "COHE-D2"]);
    expect(svc.briefNotes("COHE")).toHaveLength(1);
    expect(svc.listProjects().map((p) => p.key)).not.toContain("CONT");
    expect(svc.inbox("me").some((n) => n.message.includes("merged CONT"))).toBe(true);
  });

  it("keeps both briefs when the target already has one", () => {
    svc.mergeProject("IYF", "SCH", "me");
    svc.updateProject("SCH", { brief: "Schools brief" }, "me");
    svc.createProject({ name: "Extra", key: "EXT", brief: "Extra brief" }, "me");
    svc.mergeProject("EXT", "SCH", "me");
    expect(svc.project("SCH").brief).toBe("Schools brief");
    expect(svc.briefNotes("SCH").some((n) => n.body.includes("Extra brief"))).toBe(true);
  });
});
