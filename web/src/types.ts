// Mirrors server/src/service.ts and server/src/domain.ts.

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "review", "testing", "blocked", "done", "canceled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const TASK_TYPES = ["feature", "bug", "test", "review", "chore", "research", "docs"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const PLATFORMS = ["claude-code", "codex", "grok", "chatgpt", "cursor", "gemini", "human", "other"] as const;
export const ROLES = ["developer", "tester", "reviewer", "architect", "pm", "designer", "devops", "researcher", "generalist"] as const;
export const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;
export const DECISION_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const;
export const TRIGGER_TYPES = ["none", "claude", "codex", "grok", "command", "webhook"] as const;
export const WAKE_TYPES = ["assigned", "mentioned", "handoff", "review_request"] as const;

export interface TriggerConfig {
  type: (typeof TRIGGER_TYPES)[number];
  enabled: boolean;
  on?: string[];
  command?: string;
  args?: string[];
  model?: string;
  cwd?: string;
  url?: string;
  secret?: string;
  timeout_minutes?: number;
  respect_budget?: boolean;
  /** Set when a webhook secret is stored; the secret itself is never sent to clients. */
  has_secret?: boolean;
}

export interface Budget {
  actor: string;
  budget: number;
  period: "day" | "week" | "month";
  used: number;
  remaining: number | null;
  ratio: number | null;
  period_start: string;
}

export interface Actor {
  id: string;
  name: string;
  kind: "human" | "agent";
  platform: string;
  role: string;
  color: string;
  emoji: string;
  description: string;
  token_budget: number;
  budget_period: "day" | "week" | "month";
  status: string;
  status_note: string;
  last_seen_at: string | null;
  trigger: TriggerConfig;
  has_token: boolean;
  archived: boolean;
  created_at: string;
  budget?: Budget;
  unread?: number;
}

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  status: (typeof PROJECT_STATUSES)[number];
  priority: Priority;
  repo_path: string;
  repo_url: string;
  owner: string | null;
  brief: string;
  created_at: string;
  updated_at: string;
  counts?: Record<string, number>;
  open_tasks?: number;
  total_tasks?: number;
}

export interface Group {
  id: string;
  project_id: string;
  name: string;
  color: string;
  position: number;
  collapsed: boolean;
}

export interface Task {
  id: string;
  key: string;
  number: number;
  project_id: string;
  project_key: string;
  group_id: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  type: TaskType;
  assignee: string | null;
  reporter: string | null;
  parent_id: string | null;
  parent_key: string | null;
  tags: string[];
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  estimate_tokens: number;
  tokens_used: number;
  position: number;
  lease_holder: string | null;
  lease_expires_at: string | null;
  handoff_count: number;
  blocked_by: string[];
  blocks: string[];
  subtask_count: number;
  subtasks_done: number;
  comment_count: number;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  task_id: string;
  author: string | null;
  kind: "comment" | "handoff" | "report" | "system";
  body: string;
  created_at: string;
}

export interface Decision {
  id: string;
  ref: string;
  number: number;
  project_id: string | null;
  project_key: string | null;
  task_id: string | null;
  task_key: string | null;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  alternatives: string;
  status: (typeof DECISION_STATUSES)[number];
  author: string | null;
  created_at: string;
}

export interface Notification {
  id: string;
  recipient: string;
  sender: string | null;
  type: string;
  task_id: string | null;
  task_key: string | null;
  task_title: string | null;
  project_id: string | null;
  message: string;
  read_at: string | null;
  created_at: string;
}

export interface Activity {
  id: number;
  actor: string | null;
  type: string;
  project_id: string | null;
  task_id: string | null;
  task_key?: string | null;
  summary: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface Run {
  id: string;
  actor: string;
  task_id: string | null;
  task_key?: string | null;
  trigger_type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  reason: string;
  exit_code: number | null;
  output: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface Recommendation {
  task: Task;
  score: number;
  reasons: string[];
  over_budget: boolean;
}

export interface Overview {
  projects: Project[];
  actors: Actor[];
  budgets: Array<Budget & { name: string }>;
  by_status: Record<string, number>;
  overdue: number;
  done_this_week: number;
  in_progress: Task[];
  recent_decisions: Decision[];
  activity: Activity[];
  usage: Array<{ actor: string; day: string; tokens: number }>;
}

export interface Me {
  actor: Actor;
  budget: Budget;
  unread: number;
  owner: string;
  version: string;
}

export interface Snippet {
  id: string;
  title: string;
  description: string;
  language: string;
  code: string;
}

export interface TaskDetail {
  task: Task;
  comments: Comment[];
  subtasks: Task[];
  decisions: Decision[];
  activity: Activity[];
  runs: Run[];
}

export interface AgentDetail {
  actor: Actor;
  budget: Budget;
  tasks: Task[];
  next: Recommendation[];
  runs: Run[];
  activity: Activity[];
}
