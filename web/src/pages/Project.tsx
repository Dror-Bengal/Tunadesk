import { Fragment, useMemo, useState } from "react";
import { ApiError, del, invalidate, patch, post, useApi } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { useDesk } from "../data";
import { href, navigate, openTask, setQuery, useRoute } from "../router";
import { PALETTE, PRIORITY_COLOR, PROJECT_STATUS_COLOR, STATUS_COLOR, dueState, fmtDate, fmtTokens, readableText, relTime } from "../format";
import { PRIORITIES, PROJECT_STATUSES, TASK_STATUSES, type Activity, type BriefNote, type Group, type Priority, type Project, type Task, type TaskStatus } from "../types";
import { AgentViewLink, Avatar, Empty, Icon, KeyChip, Markdown, Modal, Pill, PopoverButton, useAction } from "../components/ui";
import { DateCell, PersonCell, PriorityCell, StatusCell, TokensCell, TypeCell, typeIcon } from "../components/cells";
import { Battery } from "./Home";
import { DecisionList } from "./Decisions";

type View = "table" | "kanban" | "brief" | "decisions" | "activity";

export function useTaskUpdate() {
  const run = useAction();
  return (key: string, body: Record<string, unknown>) =>
    run(async () => {
      await patch(`/api/tasks/${key}`, body);
      invalidate();
    });
}

export function ProjectPage({ projectKey, view }: { projectKey: string; view: string }) {
  const { t } = useI18n();
  const route = useRoute();
  const detail = useApi<{ project: Project; groups: Group[]; notes: BriefNote[] }>(`/api/projects/${encodeURIComponent(projectKey)}`);
  const showDone = route.query.get("done") !== "0";
  const tasks = useApi<Task[]>(`/api/tasks?project=${encodeURIComponent(projectKey)}${showDone ? "&closed=1" : ""}&limit=2000`);
  const [person, setPerson] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [settings, setSettings] = useState(false);
  const desk = useDesk();

  if (detail.error) return <div className="page"><Empty>{t("project.notFound")}</Empty></div>;
  if (!detail.data) return <div className="page">{t("common.loading")}</div>;
  const { project, groups } = detail.data;
  const all = tasks.data ?? [];
  const filtered = all.filter(
    (task) =>
      (!person || task.assignee === person) &&
      (!q || `${task.key} ${task.title} ${task.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())),
  );
  const people = [...new Set(all.map((x) => x.assignee).filter(Boolean))] as string[];
  const tab = (["table", "kanban", "brief", "decisions", "activity"] as View[]).includes(view as View) ? (view as View) : "table";
  const go = (v: View) => navigate(`/p/${project.key}${v === "table" ? "" : `/${v}`}`, Object.fromEntries(route.query.entries()));

  return (
    <div className="page" style={{ maxWidth: "none" }}>
      <div className="page-header" style={{ marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="project-dot" style={{ background: project.color, width: 14, height: 14 }} />
            {project.name}
            <KeyChip>{project.key}</KeyChip>
            <Pill color={PROJECT_STATUS_COLOR[project.status]} outline>
              {t(`pstatus.${project.status}` as MessageKey)}
            </Pill>
            <Pill color={PRIORITY_COLOR[project.priority]} outline>
              {t(`priority.${project.priority}` as MessageKey)}
            </Pill>
          </h1>
          {project.description && <p>{project.description}</p>}
        </div>
        <span className="spacer" />
        <AgentViewLink href={`/api/projects/${project.key}/board.md`} />
        <button className="btn" onClick={() => setSettings(true)}>
          <Icon name="gear" size={15} /> {t("project.settings")}
        </button>
      </div>

      <div className="tabs" role="tablist">
        {(
          [
            ["table", "table", t("project.table")],
            ["kanban", "kanban", t("project.kanban")],
            ["brief", "doc", t("project.brief")],
            ["decisions", "scale", t("project.decisions")],
            ["activity", "pulse", t("project.activity")],
          ] as Array<[View, string, string]>
        ).map(([v, icon, label]) => (
          <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? "active" : ""} onClick={() => go(v)}>
            <Icon name={icon} size={15} /> {label}
          </button>
        ))}
      </div>

      {(tab === "table" || tab === "kanban") && (
        <div className="board-toolbar">
          <NewTaskButton project={project} groups={groups} />
          <div className="search">
            <Icon name="search" size={15} />
            <input className="input" placeholder={t("nav.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("common.search")} />
          </div>
          {people.length > 0 && (
            <div className="avatar-stack" role="group" aria-label={t("project.filterPerson")} title={t("project.filterPerson")}>
              {people.map((id) => (
                <span key={id} onClick={() => setPerson(person === id ? null : id)} role="button" aria-pressed={person === id}>
                  <Avatar actor={desk.actor(id)} size={30} />
                </span>
              ))}
            </div>
          )}
          {person && (
            <button className="btn small ghost" onClick={() => setPerson(null)}>
              <Icon name="close" size={13} /> {desk.actor(person)?.name}
            </button>
          )}
          <span className="spacer" />
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={showDone} onChange={(e) => setQuery("done", e.target.checked ? null : "0")} />
            {t("project.showDone")}
          </label>
        </div>
      )}

      {tab === "table" && <TableView project={project} groups={groups} tasks={filtered} />}
      {tab === "kanban" && <KanbanView tasks={filtered.filter((x) => !x.parent_id || !filtered.some((p) => p.id === x.parent_id))} />}
      {tab === "brief" && <BriefView project={project} notes={detail.data.notes ?? []} />}
      {tab === "decisions" && <DecisionList project={project.key} />}
      {tab === "activity" && <ActivityView project={project.key} />}

      {settings && <ProjectSettings project={project} onClose={() => setSettings(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ table
function TableView({ project, groups, tasks }: { project: Project; groups: Group[]; tasks: Task[] }) {
  const { t } = useI18n();
  const run = useAction();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const ids = new Set(tasks.map((x) => x.id));
  const roots = tasks.filter((x) => !x.parent_id || !ids.has(x.parent_id));
  const childrenOf = (id: string) => tasks.filter((x) => x.parent_id === id);
  const ungrouped = roots.filter((x) => !x.group_id || !groups.some((g) => g.id === x.group_id));

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div>
      {groups.map((g) => (
        <GroupTable
          key={g.id}
          project={project}
          group={g}
          tasks={roots.filter((x) => x.group_id === g.id)}
          childrenOf={childrenOf}
          expanded={expanded}
          toggle={toggle}
          canDelete={groups.length > 1}
        />
      ))}
      {ungrouped.length > 0 && (
        <GroupTable
          project={project}
          group={{ id: "", project_id: project.id, name: "—", color: "#6e675c", position: 999, collapsed: false }}
          tasks={ungrouped}
          childrenOf={childrenOf}
          expanded={expanded}
          toggle={toggle}
          canDelete={false}
        />
      )}
      {adding ? (
        <form
          style={{ display: "flex", gap: 8, maxWidth: 360 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
            if (!name) return;
            await run(() => post(`/api/projects/${project.key}/groups`, { name, color: PALETTE[groups.length % PALETTE.length] }));
            invalidate();
            setAdding(false);
          }}
        >
          <input name="name" className="input" autoFocus placeholder={t("project.groupName")} onBlur={(e) => !e.target.value && setAdding(false)} />
          <button className="btn primary">{t("common.add")}</button>
        </form>
      ) : (
        <button className="btn" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> {t("project.addGroup")}
        </button>
      )}
    </div>
  );
}

function GroupTable({
  project,
  group,
  tasks,
  childrenOf,
  expanded,
  toggle,
  canDelete,
}: {
  project: Project;
  group: Group;
  tasks: Task[];
  childrenOf: (id: string) => Task[];
  expanded: Set<string>;
  toggle: (id: string) => void;
  canDelete: boolean;
}) {
  const { t } = useI18n();
  const run = useAction();
  const [collapsed, setCollapsed] = useState(group.collapsed);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const counts: Record<string, number> = {};
  for (const x of tasks) counts[x.status] = (counts[x.status] ?? 0) + 1;
  const pcounts: Record<string, number> = {};
  for (const x of tasks) pcounts[x.priority] = (pcounts[x.priority] ?? 0) + 1;
  const tokens = tasks.reduce((s, x) => s + x.tokens_used, 0);

  const setCollapse = (v: boolean) => {
    setCollapsed(v);
    if (group.id) void patch(`/api/groups/${group.id}`, { collapsed: v });
  };

  return (
    <section className="group" style={{ ["--gc" as string]: group.color }} aria-label={group.name}>
      <div className={`group-head${collapsed ? " collapsed" : ""}`}>
        <button className="icon-btn" onClick={() => setCollapse(!collapsed)} aria-expanded={!collapsed} aria-label={group.name} style={{ color: "var(--gc)" }}>
          <Icon name="chevron" size={18} className="caret" />
        </button>
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={async () => {
              setRenaming(false);
              if (draft.trim() && draft !== group.name) {
                await run(() => patch(`/api/groups/${group.id}`, { name: draft.trim() }));
                invalidate();
              }
            }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <h3
            onDoubleClick={() => {
              if (!group.id) return;
              setDraft(group.name);
              setRenaming(true);
            }}
          >
            {group.name}
          </h3>
        )}
        <span className="count">{t("project.items", { n: tasks.length })}</span>
        {group.id && (
          <PopoverButton className="icon-btn" label={t("common.more")} button={<Icon name="more" />}>
            {(close) => (
              <div className="menu">
                <button
                  onClick={() => {
                    close();
                    setDraft(group.name);
                    setRenaming(true);
                  }}
                >
                  <Icon name="doc" size={15} /> {t("common.edit")}
                </button>
                <div style={{ display: "flex", gap: 4, padding: "4px 8px", flexWrap: "wrap", maxWidth: 200 }}>
                  {PALETTE.map((c) => (
                    <button
                      key={c}
                      aria-label={c}
                      onClick={async () => {
                        close();
                        await run(() => patch(`/api/groups/${group.id}`, { color: c }));
                        invalidate();
                      }}
                      style={{ width: 18, height: 18, borderRadius: 4, background: c, border: 0, cursor: "pointer", padding: 0 }}
                    />
                  ))}
                </div>
                {canDelete && (
                  <>
                    <div className="sep" />
                    <button
                      className="danger"
                      onClick={async () => {
                        close();
                        if (!confirm(t("common.confirmDelete"))) return;
                        await run(() => del(`/api/groups/${group.id}`));
                        invalidate();
                      }}
                    >
                      <Icon name="trash" size={15} /> {t("project.deleteGroup")}
                    </button>
                  </>
                )}
              </div>
            )}
          </PopoverButton>
        )}
      </div>
      {!collapsed && (
        <div className="table-wrap">
          <div className="table" role="table" aria-label={group.name}>
            <div className="row" role="row">
              {(["col.task", "col.owner", "col.status", "col.priority", "col.type", "col.due", "col.tokens"] as MessageKey[]).map((k) => (
                <div key={k} className="th" role="columnheader">
                  {t(k)}
                </div>
              ))}
            </div>
            {tasks.map((task) => (
              <Fragment key={task.id}>
                <TaskRow task={task} expanded={expanded.has(task.id)} onToggle={() => toggle(task.id)} />
                {expanded.has(task.id) && childrenOf(task.id).map((c) => <TaskRow key={c.id} task={c} sub />)}
              </Fragment>
            ))}
            {group.id && <AddRow project={project} group={group} />}
            {tasks.length > 0 && (
              <div className="summary-row" aria-hidden="true">
                <div className="sticky-blank" />
                <div />
                <div>
                  <Battery counts={counts} total={tasks.length} />
                </div>
                <div>
                  <div className="battery" style={{ width: "100%", height: 20, borderRadius: 3 }}>
                    {PRIORITIES.map((p) => (pcounts[p] ? <i key={p} style={{ width: `${(pcounts[p] / tasks.length) * 100}%`, background: PRIORITY_COLOR[p] }} /> : null))}
                  </div>
                </div>
                <div />
                <div />
                <div style={{ fontSize: 12, color: "var(--text-2)" }}>{fmtTokens(tokens)}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function TaskRow({ task, sub, expanded, onToggle }: { task: Task; sub?: boolean; expanded?: boolean; onToggle?: () => void }) {
  const { t } = useI18n();
  const update = useTaskUpdate();
  const { actor } = useDesk();
  const lease = task.lease_holder ? actor(task.lease_holder) : null;
  return (
    <div className={`row${sub ? " sub" : ""}`} role="row" data-task={task.key}>
      <div className="td title-cell" role="cell">
        {!sub && task.subtask_count > 0 && (
          <button className="sub-toggle" onClick={onToggle} aria-expanded={expanded} title={t("project.subtasks")}>
            <Icon name="chevron" size={11} className="caret" />
            {task.subtasks_done}/{task.subtask_count}
          </button>
        )}
        <span title={t(`type.${task.type}` as MessageKey)}>{typeIcon(task.type)}</span>
        <button className="t" onClick={() => openTask(task.key)} title={task.title} style={{ textDecoration: task.status === "done" || task.status === "canceled" ? "line-through" : undefined, color: task.status === "canceled" ? "var(--text-3)" : undefined }}>
          {task.title}
        </button>
        <span className="meta">
          {lease && (
            <span title={t("task.claimedBy", { who: lease.name, until: new Date(task.lease_expires_at!).toLocaleTimeString() })}>
              <Icon name="lock" size={13} />
            </span>
          )}
          {task.blocked_by.length > 0 && <span title={`${t("task.blockedBy")} ${task.blocked_by.join(", ")}`} style={{ color: "var(--danger)", display: "inline-flex" }}><Icon name="alert" size={13} /></span>}
          {task.comment_count > 0 && (
            <span title={t("task.updates")} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <Icon name="comment" size={13} />
              {task.comment_count}
            </span>
          )}
          <span className="keychip">{task.key}</span>
        </span>
        <button className="icon-btn open" onClick={() => openTask(task.key)} aria-label={t("common.open")}>
          <Icon name="open" size={14} />
        </button>
      </div>
      <div className="td" role="cell">
        <PersonCell value={task.assignee} onChange={(v) => update(task.key, { assignee: v })} />
      </div>
      <div className="td" role="cell">
        <StatusCell value={task.status} onChange={(v) => update(task.key, { status: v })} />
      </div>
      <div className="td" role="cell">
        <PriorityCell value={task.priority} onChange={(v) => update(task.key, { priority: v })} />
      </div>
      <div className="td" role="cell">
        <TypeCell value={task.type} onChange={(v) => update(task.key, { type: v })} />
      </div>
      <div className="td" role="cell">
        <DateCell value={task.due_at} status={task.status} onChange={(v) => update(task.key, { due_at: v })} />
      </div>
      <div className="td" role="cell">
        <TokensCell used={task.tokens_used} estimate={task.estimate_tokens} onChange={(v) => update(task.key, { estimate_tokens: v })} />
      </div>
    </div>
  );
}

function AddRow({ project, group }: { project: Project; group: Group }) {
  const { t } = useI18n();
  const run = useAction();
  const [value, setValue] = useState("");
  return (
    <div className="add-row">
      <input
        value={value}
        placeholder={t("project.addTask")}
        aria-label={t("project.addTask")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={async (e) => {
          if (e.key !== "Enter" || !value.trim()) return;
          const title = value.trim();
          setValue("");
          await run(() => post("/api/tasks", { project: project.key, title, group: group.id, force: true }));
          invalidate();
        }}
      />
    </div>
  );
}

function NewTaskButton({ project, groups }: { project: Project; groups: Group[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn primary" onClick={() => setOpen(true)}>
        <Icon name="plus" size={15} /> {t("project.newTask")}
      </button>
      {open && <NewTaskModal project={project} groups={groups} onClose={() => setOpen(false)} />}
    </>
  );
}

export function NewTaskModal({ project, groups, parent, onClose }: { project: Project; groups: Group[]; parent?: Task; onClose: () => void }) {
  const { t } = useI18n();
  const run = useAction();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<string | null>(parent?.assignee ?? null);
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [priority, setPriority] = useState<Priority>(parent?.priority ?? "medium");
  const [type, setType] = useState<Task["type"]>(parent ? "bug" : "feature");
  const [group, setGroup] = useState(parent?.group_id ?? groups[0]?.id ?? "");
  const [due, setDue] = useState<string | null>(null);
  const [estimate, setEstimate] = useState(0);

  const [similar, setSimilar] = useState<Array<{ key: string; title: string; status: TaskStatus; assignee: string | null }>>([]);
  const submit = async (force = false) => {
    if (!title.trim()) return;
    const payload = { project: project.key, title: title.trim(), description, assignee, status, priority, type, group: group || undefined, due_at: due, estimate_tokens: estimate, parent: parent?.key, force };
    let created: Task | undefined;
    try {
      created = await post<Task>("/api/tasks", payload);
    } catch (e) {
      if (e instanceof ApiError && e.code === "possible_duplicate") {
        setSimilar((e.details?.similar as typeof similar) ?? []);
        return;
      }
      created = await run(() => Promise.reject(e));
    }
    if (created) {
      invalidate();
      onClose();
      if (!parent) openTask(created.key);
    }
  };

  return (
    <Modal
      title={parent ? `${t("task.addSubtask")} · ${parent.key}` : `${t("project.newTask")} · ${project.key}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={() => submit(similar.length > 0)} disabled={!title.trim()}>
            {similar.length ? t("task.createAnyway") : t("common.create")}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(similar.length > 0);
        }}
      >
        {similar.length > 0 && (
          <div className="callout warn" style={{ display: "block" }}>
            <strong>{t("task.similarTitle")}</strong>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              {similar.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className="btn small ghost"
                  style={{ justifyContent: "flex-start" }}
                  onClick={() => {
                    onClose();
                    openTask(m.key);
                  }}
                >
                  <KeyChip>{m.key}</KeyChip> {m.title} · {t(`status.${m.status}` as MessageKey)}
                  {m.assignee ? ` · @${m.assignee}` : ""}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 6, color: "var(--text-2)" }}>{t("task.similarHint")}</div>
          </div>
        )}
        <label className="field">
          <span>{t("project.newTaskTitle")}</span>
          <input
            className="input"
            autoFocus
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setSimilar([]);
            }}
          />
        </label>
        <label className="field">
          <span>{t("task.description")}</span>
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("task.writeUpdate")} />
        </label>
        <div className="props">
          <div className="k">{t("col.owner")}</div>
          <div className="v">
            <PersonCell value={assignee} onChange={setAssignee} showName />
          </div>
          <div className="k">{t("col.status")}</div>
          <div className="v">
            <StatusCell value={status} onChange={setStatus} />
          </div>
          <div className="k">{t("col.priority")}</div>
          <div className="v">
            <PriorityCell value={priority} onChange={setPriority} />
          </div>
          <div className="k">{t("col.type")}</div>
          <div className="v">
            <TypeCell value={type} onChange={setType} />
          </div>
          {!parent && groups.length > 0 && (
            <>
              <div className="k">{t("task.group")}</div>
              <div className="v">
                <select className="select" style={{ maxWidth: 220 }} value={group} onChange={(e) => setGroup(e.target.value)}>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="k">{t("col.due")}</div>
          <div className="v">
            <DateCell value={due} status={status} onChange={setDue} />
          </div>
          <div className="k">{t("task.estimate")}</div>
          <div className="v">
            <input className="input" type="number" min={0} step={1000} style={{ maxWidth: 160 }} value={estimate || ""} onChange={(e) => setEstimate(Number(e.target.value) || 0)} />
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ kanban
function KanbanView({ tasks }: { tasks: Task[] }) {
  const { t, locale } = useI18n();
  const update = useTaskUpdate();
  const { actor } = useDesk();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const columns = TASK_STATUSES.filter((s) => s !== "canceled" || tasks.some((x) => x.status === "canceled"));
  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>();
    for (const s of TASK_STATUSES) m.set(s, []);
    for (const x of tasks) m.get(x.status)?.push(x);
    return m;
  }, [tasks]);

  return (
    <div className="kanban">
      {columns.map((s) => (
        <div
          key={s}
          className={`kcol${over === s ? " drop" : ""}`}
          style={{ ["--kc" as string]: STATUS_COLOR[s] }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(s);
          }}
          onDragLeave={() => setOver((o) => (o === s ? null : o))}
          onDrop={(e) => {
            e.preventDefault();
            setOver(null);
            const key = e.dataTransfer.getData("text/plain");
            const task = tasks.find((x) => x.key === key);
            if (task && task.status !== s) void update(key, { status: s });
          }}
        >
          <div className="kcol-head" style={{ color: readableText(STATUS_COLOR[s]) }}>
            {t(`status.${s}` as MessageKey)}
            <span className="n">{byStatus.get(s)?.length ?? 0}</span>
          </div>
          <div className="kcol-body">
            {byStatus.get(s)?.map((task) => {
              const state = dueState(task.due_at, task.status);
              return (
                <div
                  key={task.id}
                  role="button"
                  tabIndex={0}
                  className={`kcard${drag === task.key ? " dragging" : ""}`}
                  onKeyDown={(e) => e.key === "Enter" && openTask(task.key)}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", task.key);
                    setDrag(task.key);
                  }}
                  onDragEnd={() => setDrag(null)}
                  onClick={() => openTask(task.key)}
                >
                  <div className="top">
                    <span>{typeIcon(task.type)}</span>
                    <span className="keychip">{task.key}</span>
                    <span style={{ flex: 1 }} />
                    {task.lease_holder && <Icon name="lock" size={13} className="lease" />}
                    <Pill color={PRIORITY_COLOR[task.priority]} outline>
                      {t(`priority.${task.priority}` as MessageKey)}
                    </Pill>
                  </div>
                  <div className="title">{task.title}</div>
                  <div className="bottom">
                    {task.due_at && <span className={`due ${state ?? ""}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="clock" size={12} /> {fmtDate(task.due_at, locale)}</span>}
                    {task.subtask_count > 0 && (
                      <span>
                        <Icon name="sub" size={12} /> {task.subtasks_done}/{task.subtask_count}
                      </span>
                    )}
                    {task.comment_count > 0 && (
                      <span>
                        <Icon name="comment" size={12} /> {task.comment_count}
                      </span>
                    )}
                    {task.blocked_by.length > 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--danger)" }}><Icon name="alert" size={12} /> {task.blocked_by.join(", ")}</span>}
                    <Avatar actor={actor(task.assignee)} size={24} presence={actor(task.assignee)?.kind === "agent"} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ brief
function BriefView({ project, notes }: { project: Project; notes: BriefNote[] }) {
  const { t, locale } = useI18n();
  const run = useAction();
  const { actor } = useDesk();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.brief);
  return (
    <div className="card" style={{ maxWidth: 900 }}>
      <div className="card-head">
        <h2>{t("project.brief")}</h2>

        <span className="spacer" />
        {editing ? (
          <>
            <button className="btn small" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
            <button
              className="btn small primary"
              onClick={async () => {
                await run(() => patch(`/api/projects/${project.key}`, { brief: draft }), t("settings.saved"));
                invalidate();
                setEditing(false);
              }}
            >
              {t("common.save")}
            </button>
          </>
        ) : (
          <button
            className="btn small"
            onClick={() => {
              setDraft(project.brief);
              setEditing(true);
            }}
          >
            <Icon name="doc" size={14} /> {t("common.edit")}
          </button>
        )}
      </div>
      <div className="card-body">
        {project.brief_as_of ? (
          <div className="brief-meta">
            <Avatar actor={actor(project.brief_by)} size={18} />
            <span>
              {t("project.briefAsOf", { date: fmtDate(project.brief_as_of, locale), who: actor(project.brief_by)?.name ?? project.brief_by ?? "—" })}
              {project.brief_evidence ? ` · ${project.brief_evidence}` : ""}
            </span>
            {project.locked_to && (
              <Pill color="#8a5a1c" outline>
                <Icon name="lock" size={11} /> {t("project.lockedTo", { who: actor(project.locked_to)?.name ?? project.locked_to })}
              </Pill>
            )}
          </div>
        ) : (
          <div className="callout">
            <Icon name="bot" size={16} />
            <span>{t("project.briefHint")}</span>
          </div>
        )}
        {editing ? (
          <textarea className="textarea" dir="auto" style={{ minHeight: 360, fontFamily: "var(--mono)", fontSize: 13 }} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
        ) : project.brief ? (
          <Markdown text={project.brief} />
        ) : (
          <Empty>{t("project.briefEmpty")}</Empty>
        )}
        {notes.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 13, fontWeight: 500, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {t("project.briefNotes", { n: notes.length })}
            </h3>
            <p style={{ color: "var(--text-3)", fontSize: 13, marginTop: 0 }}>{t("project.briefNotesHint")}</p>
            {notes.map((n) => (
              <div key={n.id} className="update" style={{ borderInlineStart: "3px solid var(--accent)" }}>
                <div className="update-head">
                  <Avatar actor={actor(n.author)} size={22} />
                  <strong>{actor(n.author)?.name ?? n.author}</strong>
                  {n.as_of && <span style={{ color: "var(--text-3)", fontSize: 12 }}>{t("project.asOf", { date: fmtDate(n.as_of, locale) })}</span>}
                  {n.evidence && <span style={{ color: "var(--text-3)", fontSize: 12 }}>· {n.evidence}</span>}
                  <span className="when">
                    <button
                      className="btn small"
                      onClick={async () => {
                        await run(() => post(`/api/projects/${project.key}/notes/merged`, { ids: [n.id] }));
                        invalidate();
                      }}
                    >
                      <Icon name="check" size={12} /> {t("project.noteMerged")}
                    </button>
                  </span>
                </div>
                <div className="update-body">
                  <Markdown text={n.body} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ activity
function ActivityView({ project }: { project: string }) {
  const { locale } = useI18n();
  const { actor } = useDesk();
  const { data } = useApi<Activity[]>(`/api/activity?project=${project}&limit=200`);
  if (!data) return null;
  return (
    <div className="card" style={{ maxWidth: 900, padding: "16px 20px" }}>
      <div className="timeline">
        {data.map((a) => (
          <div key={a.id} className="tl-item">
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Avatar actor={actor(a.actor)} size={20} />
              <strong>{actor(a.actor)?.name ?? "Tunadesk"}</strong>
              <span className="when">{relTime(a.created_at, locale)}</span>
            </div>
            <div>
              {a.task_key ? (
                <a href={href(`/p/${project}/activity`, { task: a.task_key })}>{a.summary}</a>
              ) : (
                a.summary
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ settings
function ProjectSettings({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useI18n();
  const run = useAction();
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    repo_path: project.repo_path,
    repo_url: project.repo_url,
    status: project.status,
    priority: project.priority,
    color: project.color,
    owner: project.owner,
    locked_to: project.locked_to,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      title={`${t("project.settings")} · ${project.key}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn danger"
            style={{ marginInlineEnd: "auto" }}
            onClick={async () => {
              if (!confirm(t("common.confirmDelete"))) return;
              const ok = await run(() => del(`/api/projects/${project.key}`));
              if (ok) {
                invalidate();
                onClose();
                navigate("/");
              }
            }}
          >
            <Icon name="trash" size={14} /> {t("common.delete")}
          </button>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const ok = await run(() => patch(`/api/projects/${project.key}`, form), t("settings.saved"));
              if (ok) {
                invalidate();
                onClose();
              }
            }}
          >
            {t("common.save")}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("common.name")}</span>
        <input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className="field">
        <span>{t("common.description")}</span>
        <textarea className="textarea" rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
      </label>
      <label className="field">
        <span>{t("project.repoPath")}</span>
        <input className="input" dir="ltr" value={form.repo_path} onChange={(e) => set("repo_path", e.target.value)} />
        <small>{t("project.repoPathHint")}</small>
      </label>
      <label className="field">
        <span>{t("project.repoUrl")}</span>
        <input className="input" dir="ltr" value={form.repo_url} onChange={(e) => set("repo_url", e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>{t("project.status")}</span>
          <select className="select" value={form.status} onChange={(e) => set("status", e.target.value as Project["status"])}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`pstatus.${s}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("project.priority")}</span>
          <select className="select" value={form.priority} onChange={(e) => set("priority", e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`priority.${p}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-row">
        <div className="field">
          <span>{t("project.owner")}</span>
          <PersonCell value={form.owner} onChange={(v) => set("owner", v)} showName />
        </div>
        <div className="field">
          <span>{t("project.briefMaintainer")}</span>
          <PersonCell value={form.locked_to} onChange={(v) => set("locked_to", v)} showName />
          <small>{t("project.briefMaintainerHint")}</small>
        </div>
        <div className="field">
          <span>{t("project.color")}</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => set("color", c)}
                style={{ width: 22, height: 22, borderRadius: 6, background: c, border: c === form.color ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer" }}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
