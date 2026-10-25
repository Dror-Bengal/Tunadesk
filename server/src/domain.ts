// Shared vocabulary for the whole swarm. The web app mirrors these lists in web/src/domain.ts.

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "review", "testing", "blocked", "done", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const OPEN_STATUSES: TaskStatus[] = ["backlog", "todo", "in_progress", "review", "testing", "blocked"];
export const CLOSED_STATUSES: TaskStatus[] = ["done", "canceled"];

export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const TASK_TYPES = ["feature", "bug", "test", "review", "chore", "research", "docs"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const PLATFORMS = ["claude-code", "codex", "grok", "chatgpt", "cursor", "gemini", "human", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ROLES = ["developer", "tester", "reviewer", "architect", "pm", "designer", "devops", "researcher", "generalist"] as const;
export type Role = (typeof ROLES)[number];

export const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const DECISION_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const TRIGGER_TYPES = ["none", "claude", "codex", "grok", "command", "webhook"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const NOTIFICATION_TYPES = ["assigned", "mentioned", "handoff", "review_request", "completed", "comment", "loop_guard", "budget", "run_failed", "onboarded"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Notification types that wake an agent through its trigger. */
export const WAKING_NOTIFICATIONS: NotificationType[] = ["assigned", "mentioned", "handoff", "review_request"];

export interface TriggerConfig {
  type: TriggerType;
  enabled: boolean;
  /** Which notification types wake this agent (defaults to WAKING_NOTIFICATIONS). */
  on?: NotificationType[];
  /** Executable for command/claude/codex/grok triggers (defaults per type). */
  command?: string;
  /** Extra CLI args appended before the prompt (claude/codex/grok) or full arg template for `command`. */
  args?: string[];
  /** Model override passed to the CLI, when supported. */
  model?: string;
  /** Working directory override; defaults to the project's repo_path. */
  cwd?: string;
  /** Webhook target. */
  url?: string;
  /** Webhook HMAC secret (sha256 signature in X-Tunadesk-Signature). */
  secret?: string;
  /** Extra webhook headers, e.g. `Authorization: Bearer <key>` for a hosted agent. Secret like `secret`. */
  headers?: Record<string, string>;
  /** Max wall-clock minutes for a single run. */
  timeout_minutes?: number;
  /** Skip non-critical work when the agent has no budget left. */
  respect_budget?: boolean;
  /**
   * Where CLI agents run: "desk" (the desk's own machine), "remote" (the agent's machine via
   * `tunadesk runner`; wake-ups wait while it is offline) or "auto" (remote when connected, else desk).
   */
  where?: "auto" | "desk" | "remote";
}

export const PRIORITY_WEIGHT: Record<Priority, number> = { critical: 100, high: 60, medium: 30, low: 10 };

export class SwarmError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Structured extras for clients (e.g. the tasks a new task may duplicate). */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new SwarmError(404, "not_found", `${what} not found`);
export const badRequest = (msg: string) => new SwarmError(400, "bad_request", msg);
export const conflict = (msg: string) => new SwarmError(409, "conflict", msg);
export const forbidden = (msg: string) => new SwarmError(403, "forbidden", msg);
