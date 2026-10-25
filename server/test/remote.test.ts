import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.js";
import { startRemoteRunner, type RemoteRunnerHandle } from "../src/runner/remote.js";

let desk: ReturnType<typeof startServer> | null = null;
let remote: RemoteRunnerHandle | null = null;
afterEach(() => {
  remote?.stop();
  remote = null;
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

// Stand-in for a CLI agent on another machine: completes its task through the desk with the run token.
const FAKE_AGENT = `
const { TUNADESK_URL, TUNADESK_TOKEN, TUNADESK_TASK } = process.env;
const h = { authorization: "Bearer " + TUNADESK_TOKEN, "content-type": "application/json" };
fetch(TUNADESK_URL + "/api/tasks/" + TUNADESK_TASK + "/complete", { method: "POST", headers: h, body: JSON.stringify({ summary: "done on " + process.cwd(), tokens_used: 77 }) })
  .then((r) => { console.log("complete:", r.status); process.exit(r.ok ? 0 : 1); });
`;

function boot() {
  const port = 44000 + Math.floor(Math.random() * 900);
  desk = startServer({ dbPath: ":memory:", port, host: "127.0.0.1", runner: true, quiet: true, runnerDebounceMs: 50 });
  const { svc } = desk;
  svc.createActor({ id: "qa", name: "QA", role: "tester" });
  const { token } = svc.createActor({
    id: "dev",
    name: "Dev",
    trigger: { type: "command", enabled: true, where: "remote", command: process.execPath, args: ["-e", FAKE_AGENT] },
  });
  // The desk's repo path does not exist on the agent's machine: the runner maps it with --repo.
  svc.createProject({ name: "Web", key: "WEB", repo_path: "/path/only/on/the/desk" });
  return { svc, url: `http://127.0.0.1:${port}`, token: token! };
}

const connect = (url: string, token: string, repos: Record<string, string> = { WEB: tmpdir() }) => {
  remote = startRemoteRunner({ url, tokens: [token], repos, name: "laptop", cliPath: "/nonexistent/cli.js", log: () => {} });
  return remote.ready;
};

describe("remote runner", () => {
  it("receives wake-ups and runs the agent in the mapped checkout", async () => {
    const { svc, url, token } = boot();
    await connect(url, token);
    expect(desk!.runner!.remoteStatus("dev")).toEqual([expect.objectContaining({ name: "laptop" })]);

    const t = svc.createTask({ project: "WEB", title: "Fix bug", assignee: "qa" });
    svc.handoff(t.key, "qa", { to: "dev", message: "please fix" });

    await until(() => svc.task(t.key).status === "done");
    await until(() => svc.runs({ actor: "dev" })[0]?.status === "succeeded");
    const run = svc.runs({ actor: "dev" })[0];
    expect(run.reason).toContain("on laptop");
    expect(run.output).toContain("complete: 200");
    expect(svc.comments(t.key).at(-1)?.body).toContain(tmpdir());
    expect(svc.budget("dev").used).toBe(77);
  });

  it("holds wake-ups while the runner is offline and delivers them on reconnect", async () => {
    const { svc, url, token } = boot();
    const t = svc.createTask({ project: "WEB", title: "Queued while away", assignee: "dev" }, "me");
    await new Promise((r) => setTimeout(r, 300));
    expect(svc.runs({ actor: "dev" })).toHaveLength(0);
    expect(svc.inbox("dev", { unread_only: true })).toHaveLength(1);

    await connect(url, token);
    await until(() => svc.task(t.key).status === "done");
    expect(svc.inbox("dev", { unread_only: true })).toHaveLength(0);
  });

  it("fails clearly when the project is not checked out on the agent's machine", async () => {
    const { svc, url, token } = boot();
    await connect(url, token, {});
    svc.createTask({ project: "WEB", title: "x", assignee: "dev" }, "me");
    await until(() => svc.runs({ actor: "dev" })[0]?.status === "failed");
    expect(svc.runs({ actor: "dev" })[0].reason).toMatch(/no local checkout for WEB.*--repo WEB=/);
    expect(svc.inbox("me").some((n) => n.type === "run_failed")).toBe(true);
  });

  it("only lets the woken agent report its run, and only agents attach runners", async () => {
    const { svc, url, token } = boot();
    const qaToken = svc.rotateToken("qa");
    const orders: Array<{ run_id: string }> = [];
    const detach = desk!.runner!.attachRemote("dev", "fake", (event, data) => {
      if (event === "wake") orders.push(data as { run_id: string });
      return true;
    });
    svc.createTask({ project: "WEB", title: "x", assignee: "dev" }, "me");
    await until(() => orders.length === 1);
    const finish = (tok: string) =>
      fetch(`${url}/api/runner/runs/${orders[0].run_id}/finish`, {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: JSON.stringify({ status: "succeeded", exit_code: 0 }),
      });
    expect((await finish(qaToken)).status).toBe(404);
    expect((await finish(token)).status).toBe(200);
    expect(svc.run(orders[0].run_id).status).toBe("succeeded");
    detach();

    const human = await fetch(`${url}/api/runner/stream`);
    expect(human.status).toBe(400);
  });
});

describe("remote runner disconnects", () => {
  it("fails the in-flight run and frees the agent when its runner drops", async () => {
    const { svc } = boot();
    let sent = 0;
    const detach = desk!.runner!.attachRemote("dev", "flaky", (event) => {
      if (event === "wake") sent++;
      return true;
    });
    const t1 = svc.createTask({ project: "WEB", title: "first", assignee: "dev" }, "me");
    await until(() => sent === 1);
    expect(desk!.runner!.isBusy("dev")).toBe(true);
    detach();
    const run = svc.runs({ actor: "dev" })[0];
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/disconnected during the run/);
    expect(desk!.runner!.isBusy("dev")).toBe(false);
    expect(t1.key).toBe("WEB-1");
  });
});
