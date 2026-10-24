import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.js";

let desk: ReturnType<typeof startServer> | null = null;
afterEach(() => {
  desk?.close();
  desk = null;
});

const until = async (fn: () => boolean, ms = 10_000) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

// A stand-in for Claude/Codex: reads its env, calls back with the ephemeral token and completes the task.
const FAKE_AGENT = `
const { TUNADESK_URL, TUNADESK_TOKEN, TUNADESK_TASK } = process.env;
const h = { authorization: "Bearer " + TUNADESK_TOKEN, "content-type": "application/json" };
fetch(TUNADESK_URL + "/api/tasks/" + TUNADESK_TASK + "/claim", { method: "POST", headers: h })
  .then(() => fetch(TUNADESK_URL + "/api/tasks/" + TUNADESK_TASK + "/complete", { method: "POST", headers: h, body: JSON.stringify({ summary: "fixed by fake agent", tokens_used: 4242 }) }))
  .then((r) => { console.log("complete:", r.status); process.exit(r.ok ? 0 : 1); });
`;

describe("runner", () => {
  it("wakes an agent on handoff and lets it finish the task", async () => {
    const port = 46000 + Math.floor(Math.random() * 1000);
    desk = startServer({ dbPath: ":memory:", port, host: "127.0.0.1", runner: true, quiet: true, runnerDebounceMs: 50 });
    const { svc } = desk;
    svc.createActor({ id: "qa", name: "QA", role: "tester" });
    svc.createActor({
      id: "dev",
      name: "Dev",
      trigger: { type: "command", enabled: true, command: process.execPath, args: ["-e", FAKE_AGENT] },
    });
    svc.createProject({ name: "Web", key: "WEB", repo_path: tmpdir() });
    const t = svc.createTask({ project: "WEB", title: "Bug", assignee: "qa" });
    svc.handoff(t.key, "qa", { to: "dev", message: "please fix" });

    await until(() => svc.runs({ actor: "dev" }).some((r) => r.status === "succeeded" || r.status === "failed"));
    const run = svc.runs({ actor: "dev" })[0];
    expect(run.output).toContain("complete: 200");
    expect(run.status).toBe("succeeded");
    expect(svc.task(t.key).status).toBe("done");
    expect(svc.budget("dev").used).toBe(4242);
    // The ephemeral token is revoked once the run ends.
    expect(svc.inbox("dev", { unread_only: true })).toHaveLength(0);
  });

  it("skips runs when the project has no repo path", async () => {
    const port = 47000 + Math.floor(Math.random() * 1000);
    desk = startServer({ dbPath: ":memory:", port, host: "127.0.0.1", runner: true, quiet: true, runnerDebounceMs: 50 });
    const { svc } = desk;
    svc.createActor({ id: "dev", name: "Dev", trigger: { type: "command", enabled: true, command: process.execPath, args: ["-e", "1"] } });
    svc.createProject({ name: "Web", key: "WEB" });
    svc.createTask({ project: "WEB", title: "x", assignee: "dev" }, "me");
    await until(() => svc.runs({ actor: "dev" }).length > 0);
    expect(svc.runs({ actor: "dev" })[0].status).toBe("skipped");
    expect(svc.runs({ actor: "dev" })[0].reason).toMatch(/repo path/);
  });

  it("refuses to bind publicly without an admin token", () => {
    expect(() => startServer({ dbPath: ":memory:", port: 48999, host: "0.0.0.0", runner: false, quiet: true })).toThrow(/TUNADESK_ADMIN_TOKEN/);
  });
});
