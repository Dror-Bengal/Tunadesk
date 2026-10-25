import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// node:sqlite still prints an ExperimentalWarning on some Node 22 builds; it is stable enough for us.
const originalEmit = process.emit;
// @ts-expect-error - narrow override to silence one specific warning
process.emit = function (name: string, data: { name?: string; message?: string }, ...args: unknown[]) {
  if (name === "warning" && data?.name === "ExperimentalWarning" && String(data.message).includes("SQLite")) return false;
  // @ts-expect-error - passthrough
  return originalEmit.call(process, name, data, ...args);
};

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
    platform TEXT NOT NULL DEFAULT 'other',
    role TEXT NOT NULL DEFAULT 'developer',
    color TEXT NOT NULL DEFAULT '#579bfc',
    emoji TEXT NOT NULL DEFAULT '🤖',
    description TEXT NOT NULL DEFAULT '',
    token_budget INTEGER NOT NULL DEFAULT 0,
    budget_period TEXT NOT NULL DEFAULT 'day' CHECK (budget_period IN ('day','week','month')),
    status TEXT NOT NULL DEFAULT 'offline',
    status_note TEXT NOT NULL DEFAULT '',
    last_seen_at TEXT,
    trigger_json TEXT NOT NULL DEFAULT '{"type":"none","enabled":false}',
    token_hash TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#579bfc',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
    priority TEXT NOT NULL DEFAULT 'medium',
    repo_path TEXT NOT NULL DEFAULT '',
    repo_url TEXT NOT NULL DEFAULT '',
    owner TEXT REFERENCES actors(id) ON DELETE SET NULL,
    brief TEXT NOT NULL DEFAULT '',
    task_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#579bfc',
    position REAL NOT NULL DEFAULT 0,
    collapsed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX groups_project ON groups(project_id, position);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    number INTEGER NOT NULL,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    type TEXT NOT NULL DEFAULT 'feature',
    assignee TEXT REFERENCES actors(id) ON DELETE SET NULL,
    reporter TEXT REFERENCES actors(id) ON DELETE SET NULL,
    parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    due_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    estimate_tokens INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    lease_holder TEXT REFERENCES actors(id) ON DELETE SET NULL,
    lease_expires_at TEXT,
    handoff_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_project ON tasks(project_id, status);
  CREATE INDEX tasks_assignee ON tasks(assignee, status);
  CREATE INDEX tasks_parent ON tasks(parent_id);

  CREATE TABLE task_links (
    from_task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    to_task TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'blocks' CHECK (type IN ('blocks','relates')),
    PRIMARY KEY (from_task, to_task, type)
  );

  CREATE TABLE comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author TEXT REFERENCES actors(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','handoff','report','system')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_task ON comments(task_id, created_at);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    alternatives TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('proposed','accepted','rejected','superseded')),
    author TEXT REFERENCES actors(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX decisions_project ON decisions(project_id, created_at);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    sender TEXT REFERENCES actors(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '',
    read_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX notifications_recipient ON notifications(recipient, read_at);

  CREATE TABLE usage (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX usage_actor ON usage(actor, created_at);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT,
    type TEXT NOT NULL,
    project_id TEXT,
    task_id TEXT,
    summary TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX activity_project ON activity(project_id, id);
  CREATE INDEX activity_task ON activity(task_id, id);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    notification_id TEXT,
    trigger_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','skipped')),
    reason TEXT NOT NULL DEFAULT '',
    exit_code INTEGER,
    output TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX runs_actor ON runs(actor, created_at);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2 — move stored colours from the original bright palette to the deep one
  `
  UPDATE projects SET color = CASE lower(color) WHEN '#579bfc' THEN '#44546a' WHEN '#00c875' THEN '#2f6b4f' WHEN '#a25ddc' THEN '#6b4a8a' WHEN '#fdab3d' THEN '#a8661c' WHEN '#e2445c' THEN '#9e2f3a' WHEN '#0086c0' THEN '#2d6a6a' WHEN '#ff642e' THEN '#8c4a2f' WHEN '#037f4c' THEN '#5c6b2f' WHEN '#bb3354' THEN '#7a3b5c' WHEN '#784bd1' THEN '#4e4a8c' WHEN '#ff7575' THEN '#8c4a2f' WHEN '#66ccff' THEN '#2d6a6a' WHEN '#c4c4c4' THEN '#6e675c' WHEN '#ff7a45' THEN '#8c4a2f' WHEN '#2f5bea' THEN '#44546a' WHEN '#676879' THEN '#57534c' WHEN '#333333' THEN '#7a1f2b' WHEN '#401694' THEN '#8a5a1c' WHEN '#5559df' THEN '#3d5a52' ELSE color END;
  UPDATE groups SET color = CASE lower(color) WHEN '#579bfc' THEN '#44546a' WHEN '#00c875' THEN '#2f6b4f' WHEN '#a25ddc' THEN '#6b4a8a' WHEN '#fdab3d' THEN '#a8661c' WHEN '#e2445c' THEN '#9e2f3a' WHEN '#0086c0' THEN '#2d6a6a' WHEN '#ff642e' THEN '#8c4a2f' WHEN '#037f4c' THEN '#5c6b2f' WHEN '#bb3354' THEN '#7a3b5c' WHEN '#784bd1' THEN '#4e4a8c' WHEN '#ff7575' THEN '#8c4a2f' WHEN '#66ccff' THEN '#2d6a6a' WHEN '#c4c4c4' THEN '#6e675c' WHEN '#ff7a45' THEN '#8c4a2f' WHEN '#2f5bea' THEN '#44546a' WHEN '#676879' THEN '#57534c' WHEN '#333333' THEN '#7a1f2b' WHEN '#401694' THEN '#8a5a1c' WHEN '#5559df' THEN '#3d5a52' ELSE color END;
  UPDATE actors SET color = CASE lower(color) WHEN '#579bfc' THEN '#44546a' WHEN '#00c875' THEN '#2f6b4f' WHEN '#a25ddc' THEN '#6b4a8a' WHEN '#fdab3d' THEN '#a8661c' WHEN '#e2445c' THEN '#9e2f3a' WHEN '#0086c0' THEN '#2d6a6a' WHEN '#ff642e' THEN '#8c4a2f' WHEN '#037f4c' THEN '#5c6b2f' WHEN '#bb3354' THEN '#7a3b5c' WHEN '#784bd1' THEN '#4e4a8c' WHEN '#ff7575' THEN '#8c4a2f' WHEN '#66ccff' THEN '#2d6a6a' WHEN '#c4c4c4' THEN '#6e675c' WHEN '#ff7a45' THEN '#8c4a2f' WHEN '#2f5bea' THEN '#44546a' WHEN '#676879' THEN '#57534c' WHEN '#333333' THEN '#7a1f2b' WHEN '#401694' THEN '#8a5a1c' WHEN '#5559df' THEN '#3d5a52' ELSE color END;
  `,
  // v3 — freshness of knowledge: who wrote a brief and "as of" when, notes from less-informed agents, status dates
  `
  ALTER TABLE projects ADD COLUMN brief_as_of TEXT;
  ALTER TABLE projects ADD COLUMN brief_by TEXT;
  ALTER TABLE projects ADD COLUMN brief_evidence TEXT NOT NULL DEFAULT '';
  ALTER TABLE projects ADD COLUMN locked_to TEXT;
  ALTER TABLE tasks ADD COLUMN status_changed_at TEXT;
  UPDATE tasks SET status_changed_at = COALESCE(completed_at, started_at, updated_at, created_at);
  CREATE TABLE brief_notes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    author TEXT REFERENCES actors(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    as_of TEXT,
    evidence TEXT NOT NULL DEFAULT '',
    merged_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX brief_notes_project ON brief_notes(project_id, created_at);
  `,
  // v4 — project identity beyond folders: aliases (e.g. chat session names), where each agent knows a project
  // from, and redirects so old keys keep working after a task move or a project merge
  `
  ALTER TABLE projects ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE project_sources (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    actor TEXT REFERENCES actors(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session','folder','repo','other')),
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, actor, kind, value)
  );
  CREATE TABLE key_redirects (
    old_key TEXT PRIMARY KEY COLLATE NOCASE,
    kind TEXT NOT NULL CHECK (kind IN ('task','project')),
    target_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // v5 — clients: the level above projects (client > project > tasks)
  `
  CREATE TABLE clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    color TEXT NOT NULL DEFAULT '#57534c',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE projects ADD COLUMN client_id TEXT REFERENCES clients(id) ON DELETE SET NULL;
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  // Loaded lazily so the warning filter above is installed before node:sqlite initialises.
  const { DatabaseSync: Database } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
