import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Service } from "../src/service.js";

let svc: Service;

beforeEach(() => {
  svc = new Service(openDb(":memory:"));
  svc.createActor({ id: "me", name: "Me", kind: "human" });
  svc.createActor({ id: "claude-dev", name: "Claude Dev", platform: "claude-code", role: "developer", token_budget: 100_000 });
  svc.createActor({ id: "codex-qa", name: "Codex QA", platform: "codex", role: "tester" });
});

describe("projects and tasks", () => {
  it("creates a project with default groups and sequential task keys", () => {
    const p = svc.createProject({ name: "Payments Web" }, "me");
    expect(p.key).toBe("PW");
    expect(svc.groups(p.key).map((g) => g.name)).toEqual(["Now", "Next", "Later"]);
    const a = svc.createTask({ project: "PW", title: "First" }, "me");
    const b = svc.createTask({ project: "pw", title: "Second" }, "me");
    expect([a.key, b.key]).toEqual(["PW-1", "PW-2"]);
    expect(a.group_id).toBe(svc.groups("PW")[0].id);
  });

  it("dedupes derived project keys", () => {
    svc.createProject({ name: "Alpha" });
    const second = svc.createProject({ name: "Alpha" });
    expect(second.key).toBe("ALPH2");
  });

  it("tracks status timestamps and notifies new assignees", () => {
    svc.createProject({ name: "Core", key: "CORE" });
    const t = svc.createTask({ project: "CORE", title: "Build API" }, "me");
    const started = svc.updateTask(t.key, { status: "in_progress", assignee: "claude-dev" }, "me");
    expect(started.started_at).toBeTruthy();
    expect(svc.inbox("claude-dev").map((n) => n.type)).toEqual(["assigned"]);
    const done = svc.updateTask(t.key, { status: "done" }, "claude-dev");
    expect(done.completed_at).toBeTruthy();
    expect(svc.inbox("me").map((n) => n.type)).toContain("completed");
  });

  it("notifies @mentions in comments", () => {
    svc.createProject({ name: "Core", key: "CORE" });
    const t = svc.createTask({ project: "CORE", title: "x" }, "me");
    svc.addComment(t.key, "me", "hey @codex-qa please check, and @nobody");
    const inbox = svc.inbox("codex-qa");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("mentioned");
    expect(inbox[0].task_key).toBe("CORE-1");
  });
});

describe("agent workflow", () => {
  beforeEach(() => {
    svc.createProject({ name: "Core", key: "CORE" });
  });

  it("claims with a lease and rejects a second claimer", () => {
    const t = svc.createTask({ project: "CORE", title: "x" }, "me");
    const claimed = svc.claim(t.key, "claude-dev");
    expect(claimed.status).toBe("in_progress");
    expect(claimed.assignee).toBe("claude-dev");
    expect(claimed.lease_holder).toBe("claude-dev");
    expect(() => svc.claim(t.key, "codex-qa")).toThrow(/claimed by claude-dev/);
    svc.release(t.key, "claude-dev");
    expect(svc.claim(t.key, "codex-qa").lease_holder).toBe("codex-qa");
  });

  it("refuses to claim blocked tasks", () => {
    const a = svc.createTask({ project: "CORE", title: "schema" }, "me");
    const b = svc.createTask({ project: "CORE", title: "api", blocked_by: [a.key] }, "me");
    expect(svc.task(b.key).blocked_by).toEqual([a.key]);
    expect(() => svc.claim(b.key, "claude-dev")).toThrow(/blocked by/);
    svc.updateTask(a.key, { status: "done" }, "me");
    expect(svc.task(b.key).blocked_by).toEqual([]);
  });

  it("hands off with bug sub-tasks, then trips the loop guard", () => {
    const t = svc.createTask({ project: "CORE", title: "login", assignee: "claude-dev" }, "me");
    const toQa = svc.handoff(t.key, "claude-dev", { to: "codex-qa", message: "ready for testing" });
    expect(toQa.task.status).toBe("testing");
    expect(toQa.task.assignee).toBe("codex-qa");
    expect(svc.inbox("codex-qa")[0].type).toBe("handoff");

    const back = svc.handoff(t.key, "codex-qa", {
      to: "claude-dev",
      message: "2 bugs found",
      subtasks: [{ title: "Crash on empty password" }, { title: "Typo in error" }],
      tokens_used: 1200,
    });
    expect(back.subtasks.map((s) => s.key)).toEqual(["CORE-2", "CORE-3"]);
    expect(back.subtasks.every((s) => s.assignee === "claude-dev" && s.parent_key === "CORE-1")).toBe(true);
    expect(svc.task(t.key).subtask_count).toBe(2);
    expect(svc.task(t.key).tokens_used).toBe(1200);

    svc.setSetting("loop_guard_limit", 3);
    svc.handoff(t.key, "claude-dev", { to: "codex-qa", message: "fixed" });
    const tripped = svc.handoff(t.key, "codex-qa", { to: "claude-dev", message: "still broken" });
    expect(tripped.loop_guard).toBe(true);
    expect(tripped.task.status).toBe("blocked");
    expect(svc.inbox("me").some((n) => n.type === "loop_guard")).toBe(true);
  });

  it("completes with a report and records usage against budget", () => {
    const t = svc.createTask({ project: "CORE", title: "x", assignee: "claude-dev" }, "me");
    svc.claim(t.key, "claude-dev");
    const done = svc.complete(t.key, "claude-dev", { summary: "Implemented and tested", tokens_used: 30_000 });
    expect(done.status).toBe("done");
    expect(done.lease_holder).toBeNull();
    expect(svc.comments(t.key).at(-1)?.kind).toBe("report");
    const b = svc.budget("claude-dev");
    expect(b.used).toBe(30_000);
    expect(b.remaining).toBe(70_000);
  });

  it("recommends work by priority, in-progress state and budget", () => {
    svc.createTask({ project: "CORE", title: "low", priority: "low", assignee: "claude-dev" }, "me");
    const crit = svc.createTask({ project: "CORE", title: "crit", priority: "critical", assignee: "claude-dev" }, "me");
    const huge = svc.createTask({ project: "CORE", title: "huge", priority: "high", assignee: "claude-dev", estimate_tokens: 500_000 }, "me");
    svc.createTask({ project: "CORE", title: "unassigned bug", type: "bug", priority: "medium" }, "me");
    const recs = svc.recommend("claude-dev", 10);
    expect(recs[0].task.key).toBe(crit.key);
    const hugeRec = recs.find((r) => r.task.key === huge.key)!;
    expect(hugeRec.over_budget).toBe(true);
    expect(recs.some((r) => r.task.title === "unassigned bug")).toBe(true);

    svc.recordUsage("claude-dev", 100_000);
    const after = svc.recommend("claude-dev", 10);
    expect(after.map((r) => r.task.key)).toEqual([crit.key]);
    expect(svc.inbox("me").some((n) => n.type === "budget")).toBe(true);
  });

  it("builds a briefing", () => {
    svc.createTask({ project: "CORE", title: "x", assignee: "claude-dev" }, "me");
    svc.logDecision({ project: "CORE", title: "Use SQLite", decision: "SQLite for v1", rationale: "zero setup" }, "me");
    const b = svc.briefing("claude-dev");
    expect(b.me.id).toBe("claude-dev");
    expect(b.inbox).toHaveLength(1);
    expect(b.my_tasks).toHaveLength(1);
    expect(b.decisions[0].ref).toBe("CORE-D1");
  });

  it("authenticates by token", () => {
    const { token } = svc.createActor({ id: "grok", name: "Grok", platform: "grok" });
    expect(token).toMatch(/^tdk_/);
    expect(svc.actorByToken(token!)?.id).toBe("grok");
    const rotated = svc.rotateToken("grok");
    expect(svc.actorByToken(token!)).toBeNull();
    expect(svc.actorByToken(rotated)?.id).toBe("grok");
  });

  it("emits events after mutations", async () => {
    const seen: string[] = [];
    svc.events.on("event", (e) => seen.push(e.type));
    svc.createTask({ project: "CORE", title: "x" }, "me");
    await Promise.resolve();
    expect(seen).toContain("task.created");
  });
});
