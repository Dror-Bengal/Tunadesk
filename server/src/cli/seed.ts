import type { Service } from "../service.js";
import { newId } from "../util.js";

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** A small, realistic desk: three agents on three projects, including a dev ⇄ QA handoff loop. */
export function seedDemo(svc: Service): Record<string, string> {
  const tokens: Record<string, string> = {};
  const add = (input: Parameters<Service["createActor"]>[0]) => {
    if (svc.findActor(input.id!)) return;
    const { token } = svc.createActor(input, "me");
    if (token) tokens[input.id!] = token;
  };
  add({
    id: "claude-dev",
    name: "Claude Dev",
    platform: "claude-code",
    role: "developer",
    emoji: "🧠",
    color: "#ff7a45",
    token_budget: 400_000,
    budget_period: "day",
    description: "Senior full-stack developer. Writes tests with every change.",
    trigger: { type: "claude", enabled: false },
  });
  add({
    id: "codex-qa",
    name: "Codex QA",
    platform: "codex",
    role: "tester",
    emoji: "🧪",
    color: "#00c875",
    token_budget: 250_000,
    budget_period: "day",
    description: "QA engineer. Reproduces, writes failing tests, files one bug per issue.",
    trigger: { type: "codex", enabled: false },
  });
  add({
    id: "grok-research",
    name: "Grok Research",
    platform: "grok",
    role: "researcher",
    emoji: "🔭",
    color: "#a25ddc",
    token_budget: 150_000,
    budget_period: "day",
    description: "Market and technical research; summarises sources with links.",
    trigger: { type: "grok", enabled: false },
  });

  if (svc.findProject("WEB")) return tokens;

  // ---------------------------------------------------------------- WEB
  svc.createProject(
    {
      name: "Marketing site",
      key: "WEB",
      description: "The public site: landing, pricing, docs entry points.",
      priority: "high",
      repo_url: "https://github.com/example/marketing-site",
      brief: [
        "**Goal:** launch the new site with self-serve pricing by end of month.",
        "**Stack:** Astro + Tailwind, deployed on Vercel. Forms go to the Billing API.",
        "**Conventions:** components in `src/components`, one Playwright spec per page, Lighthouse ≥ 95.",
      ].join("\n"),
    },
    "me",
  );
  const hero = svc.createTask({ project: "WEB", title: "Redesign hero section", type: "feature", priority: "high", assignee: "claude-dev", estimate_tokens: 60_000, due_at: days(2), tags: ["design"] }, "me");
  svc.claim(hero.key, "claude-dev", 120);
  svc.addComment(hero.key, "claude-dev", "New layout is in; wiring the animated product shot next. Screenshots in the PR.");
  const pricing = svc.createTask({ project: "WEB", title: "Pricing page with plan toggle", type: "feature", priority: "high", assignee: "claude-dev", estimate_tokens: 45_000 }, "me");
  svc.complete(pricing.key, "claude-dev", { summary: "Monthly/annual toggle, 3 plans, FAQ. Unit tests for price math.", status: "review", next_assignee: "me", tokens_used: 38_000 });

  const contact = svc.createTask(
    { project: "WEB", title: "Contact form → CRM", type: "feature", priority: "medium", assignee: "claude-dev", description: "Validate, rate-limit and post to the Billing API `/leads`.", estimate_tokens: 30_000 },
    "me",
  );
  svc.claim(contact.key, "claude-dev");
  svc.handoff(contact.key, "claude-dev", { to: "codex-qa", message: "Form is done on branch `contact-form`. Please test validation, error states and the happy path against staging.", tokens_used: 24_000 });
  svc.handoff(contact.key, "codex-qa", {
    to: "claude-dev",
    message: "Tested 14 cases, 2 failures. Repro steps are in each sub-task. Failing specs pushed to `contact-form`.",
    tokens_used: 31_000,
    subtasks: [
      { title: "Email validation accepts `a@b`", description: "Expected rejection; spec `contact.spec.ts:42`.", priority: "medium" },
      { title: "Submit button stays disabled after a server error", description: "Retry is impossible without reload.", priority: "high" },
    ],
  });
  svc.createTask({ project: "WEB", title: "Lighthouse pass on all pages", type: "test", priority: "low", group: "Next", assignee: "codex-qa", estimate_tokens: 15_000 }, "me");
  svc.createTask({ project: "WEB", title: "Write launch blog post", type: "docs", priority: "low", group: "Later" }, "me");
  svc.logDecision(
    {
      project: "WEB",
      title: "Astro instead of Next.js",
      context: "Mostly static marketing pages, a few islands of interactivity.",
      decision: "Build the site with Astro + Tailwind.",
      rationale: "Ships ~0 JS by default; Lighthouse budget is easier; the team (and agents) already know Tailwind.",
      alternatives: "Next.js (heavier runtime), plain HTML (no components).",
    },
    "claude-dev",
  );
  svc.logDecision(
    { project: "WEB", task: contact.key, title: "One bug sub-task per failing case", decision: "QA files each failure as its own sub-task assigned back to the developer.", rationale: "Lets dev claim and close them independently; keeps the handoff thread short." },
    "codex-qa",
  );

  // ---------------------------------------------------------------- API
  svc.createProject(
    {
      name: "Billing API",
      key: "API",
      description: "Subscriptions, invoices and webhooks.",
      priority: "critical",
      brief: "**Goal:** self-serve checkout for the new pricing.\n**Stack:** Node + Postgres + Stripe.\n**Rule:** every money-moving endpoint must be idempotent.",
    },
    "me",
  );
  const webhooks = svc.createTask(
    { project: "API", title: "Stripe webhook handler", type: "feature", priority: "critical", assignee: "claude-dev", due_at: days(1), estimate_tokens: 80_000, description: "Handle `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`. Verify signatures." },
    "me",
  );
  svc.createTask({ project: "API", title: "Idempotency keys on POST /subscriptions", type: "feature", priority: "high", assignee: "claude-dev", blocked_by: [webhooks.key], estimate_tokens: 35_000 }, "me");
  svc.createTask({ project: "API", title: "Load test checkout flow (500 rps)", type: "test", priority: "medium", group: "Next", estimate_tokens: 40_000 }, "me");
  svc.createTask({ project: "API", title: "Rate limiting per API key", type: "feature", priority: "medium", status: "backlog", group: "Later" }, "me");
  svc.logDecision(
    { project: "API", title: "Postgres advisory locks for webhook dedupe", decision: "Use `pg_advisory_xact_lock(event_id)` and a processed_events table.", rationale: "Stripe retries; we need exactly-once effects without a queue for v1.", status: "proposed" },
    "claude-dev",
  );

  // ---------------------------------------------------------------- RES
  svc.createProject({ name: "Market research", key: "RES", description: "Who else is building agent task desks?", priority: "low" }, "me");
  const scan = svc.createTask({ project: "RES", title: "Competitor scan: agent task managers", type: "research", priority: "medium", assignee: "grok-research" }, "me");
  svc.complete(scan.key, "grok-research", { summary: "Found 7 tools; none combine cross-platform agents, budgets and handoffs. Table attached in the brief.", tokens_used: 52_000 });
  svc.createTask({ project: "RES", title: "Survey: how do people split work across Claude/Codex/Grok?", type: "research", priority: "low", assignee: "grok-research" }, "me");
  svc.updateProject("RES", { status: "paused" }, "me");

  // A week of usage history so the charts have something to say.
  const insert = svc.db.prepare("INSERT INTO usage (id, actor, task_id, tokens, cost_usd, note, created_at) VALUES (?, ?, NULL, ?, 0, 'history', ?)");
  const profile: Record<string, number> = { "claude-dev": 220_000, "codex-qa": 120_000, "grok-research": 60_000 };
  for (let d = 7; d >= 1; d--) {
    for (const [actor, base] of Object.entries(profile)) {
      const jitter = 0.55 + ((d * 37 + actor.length * 11) % 50) / 50;
      insert.run(newId("u_"), actor, Math.round(base * jitter), days(-d));
    }
  }
  svc.touchActor("claude-dev", "working", `${hero.key}: Redesign hero section`);
  svc.touchActor("codex-qa", "idle", "");
  svc.touchActor("grok-research", "offline", "");
  return tokens;
}
