import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Service } from "../src/service.js";
import { bootstrap, buildDesk } from "../src/server.js";

let svc: Service;
let app: ReturnType<typeof buildDesk>;
let a: string;

const req = (method: string, path: string, token: string, json?: unknown) =>
  app.request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });

beforeEach(() => {
  svc = new Service(openDb(":memory:"));
  bootstrap(svc);
  a = svc.createActor({ id: "claude-c", name: "Claude C" }).token!;
  app = buildDesk(svc, { trustLocal: true });
});

describe("clients", () => {
  it("creates the client with the first project and reuses it by name or alias", async () => {
    const backend = await (await req("POST", "/api/projects", a, { name: "C Backend", client: "האחים כהן" })).json();
    const client = svc.findClient("האחים כהן")!;
    expect(backend.client_id).toBe(client.id);
    svc.updateClient(client.id, { add_aliases: ["Cohen Brothers"] }, "me");

    const containers = await (await req("POST", "/api/projects", a, { name: "Cohen containers", client: "cohen brothers" })).json();
    expect(containers.client_id).toBe(client.id);
    expect(svc.listClients()).toHaveLength(1);
    expect(svc.listClients()[0].project_count).toBe(2);
  });

  it("refuses a look-alike client name from an agent, unless forced", async () => {
    svc.createClient({ name: "האחים כהן" }, "me");
    const res = await req("POST", "/api/projects", a, { name: "Timesheet", client: "האחים כהן בע״מ" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("possible_duplicate_client");
    expect((await req("POST", "/api/projects", a, { name: "Timesheet", client: "האחים כהן בע״מ", client_force: true })).status).toBe(201);
  });

  it("sets and clears a project's client, and groups the portfolio by client", async () => {
    svc.createProject({ name: "Cohen PM", key: "CP" }, "me");
    svc.createProject({ name: "Inside You Factory", key: "IYF" }, "me");
    await req("PATCH", "/api/projects/CP", a, { client: "האחים כהן" });
    const portfolio = await (await req("GET", "/api/portfolio.md", a)).text();
    expect(portfolio).toMatch(/### No client[\s\S]*IYF/);
    expect(portfolio).toMatch(/### האחים כהן[\s\S]*\*\*CP\*\*/);
    expect((await (await req("GET", "/api/projects/CP/board.md", a)).text())).toContain("Client: האחים כהן");
    await req("PATCH", "/api/projects/CP", a, { client: null });
    expect(svc.project("CP").client_id).toBeNull();
  });

  it("lets agents add aliases but not rename or delete clients", async () => {
    const c = svc.createClient({ name: "Birzia" }, "me");
    expect((await req("PATCH", `/api/clients/${c.id}`, a, { add_aliases: ["בירזיה"] })).status).toBe(200);
    expect((await req("PATCH", `/api/clients/${c.id}`, a, { name: "x" })).status).toBe(403);
    expect((await req("DELETE", `/api/clients/${c.id}`, a)).status).toBe(403);
    expect(svc.client("בירזיה").id).toBe(c.id);
  });
});
