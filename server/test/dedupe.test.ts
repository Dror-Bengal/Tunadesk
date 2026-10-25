import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db/index.js";
import { Service } from "../src/service.js";
import { bootstrap, buildDesk } from "../src/server.js";
import { normalizeRepoUrl, titleSimilarity } from "../src/dedupe.js";

let svc: Service;
let app: ReturnType<typeof buildDesk>;
let a: string;
let b: string;

const post = (path: string, token: string, json: unknown) =>
  app.request(`http://localhost${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(json) });

beforeEach(() => {
  svc = new Service(openDb(":memory:"));
  bootstrap(svc);
  a = svc.createActor({ id: "claude-a", name: "Claude A" }).token!;
  b = svc.createActor({ id: "codex-a", name: "Codex A", platform: "codex" }).token!;
  app = buildDesk(svc, { trustLocal: true });
});

describe("matching helpers", () => {
  it("normalises git remotes in every common form", () => {
    const forms = ["git@github.com:Me/App.git", "https://github.com/me/app", "https://user@github.com/me/app.git/", "ssh://git@github.com/me/app.git"];
    expect(new Set(forms.map(normalizeRepoUrl))).toEqual(new Set(["github.com/me/app"]));
  });

  it("scores similar titles in English and Hebrew, and ignores one shared word", () => {
    expect(titleSimilarity("Fix login bug", "Login bug on Safari")).toBeGreaterThanOrEqual(0.55);
    expect(titleSimilarity("Add Stripe webhooks", "Stripe webhook handler")).toBeGreaterThanOrEqual(0.55);
    expect(titleSimilarity("לתקן את באג ההתחברות", "באג בהתחברות בספארי")).toBeGreaterThanOrEqual(0.55);
    expect(titleSimilarity("Update pricing page", "Update README")).toBe(0);
  });
});

describe("projects", () => {
  it("hands back the existing project when another agent registers the same repo", async () => {
    const first = await (await post("/api/projects", a, { name: "Cohen PM", repo_url: "git@github.com:dror/cohen-pm.git", repo_path: "/Users/a/cohen-pm" })).json();
    expect(first.existing).toBeUndefined();

    const sameRemote = await post("/api/projects", b, { name: "cohen project manager", repo_url: "https://github.com/dror/cohen-pm", repo_path: "/Users/b/work/cpm" });
    expect(sameRemote.status).toBe(200);
    expect((await sameRemote.json()).key).toBe(first.key);

    const sameName = await (await post("/api/projects", b, { name: "cohen-pm" })).json();
    expect(sameName.key).toBe(first.key);
    expect(svc.listProjects()).toHaveLength(1);
  });

  it("keeps two different repos that share a name apart", async () => {
    await post("/api/projects", a, { name: "API", repo_url: "github.com/one/api" });
    const other = await post("/api/projects", b, { name: "API", repo_url: "github.com/two/api" });
    expect(other.status).toBe(201);
    expect(svc.listProjects()).toHaveLength(2);
  });
});

describe("tasks", () => {
  beforeEach(() => {
    svc.createProject({ name: "Web", key: "WEB" }, "me");
  });

  it("refuses a likely duplicate, lists it, and allows force", async () => {
    await post("/api/tasks", a, { project: "WEB", title: "Fix login bug on Safari", assignee: "claude-a" });
    const dup = await post("/api/tasks", b, { project: "WEB", title: "Safari login bug" });
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body.error.code).toBe("possible_duplicate");
    expect(body.error.similar[0].key).toBe("WEB-1");
    expect(body.error.message).toMatch(/@claude-a/);

    const forced = await post("/api/tasks", b, { project: "WEB", title: "Safari login bug", force: true });
    expect(forced.status).toBe(201);
  });

  it("does not block unrelated tasks or sub-tasks", async () => {
    await post("/api/tasks", a, { project: "WEB", title: "Fix login bug" });
    expect((await post("/api/tasks", b, { project: "WEB", title: "Write pricing copy" })).status).toBe(201);
    expect((await post("/api/tasks", b, { project: "WEB", title: "Fix login bug", parent: "WEB-1" })).status).toBe(201);
  });
});

describe("onboarding over MCP", () => {
  it("guides the agent, flags duplicates and reports to the human", async () => {
    svc.createProject({ name: "Web", key: "WEB", repo_url: "https://github.com/me/web" }, "me");
    svc.createTask({ project: "WEB", title: "Hero section redesign", assignee: "claude-a" }, "claude-a");

    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${b}` } },
        fetch: (url, init) => app.request(String(url), init as RequestInit),
      }),
    );
    const text = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0].text;

    expect(await text("onboarding_guide", {})).toContain("Tunadesk onboarding for @codex-a");
    expect(await text("create_project", { name: "web", repo_url: "git@github.com:me/web.git" })).toMatch(/already on the desk: WEB/);
    expect(await text("find_similar_tasks", { project: "WEB", title: "Redesign the hero" })).toContain("WEB-1");
    expect(await text("create_task", { project: "WEB", title: "Redesign hero section" })).toMatch(/Possible duplicate of WEB-1/);
    expect(await text("onboarding_report", { summary: "1 project found, 0 created; joined WEB-1" })).toMatch(/Reported/);
    expect(svc.inbox("me").some((n) => n.type === "onboarded" && n.message.includes("joined WEB-1"))).toBe(true);
    await client.close();
  });
});
