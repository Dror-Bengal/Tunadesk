import { useEffect, useMemo, useRef, useState } from "react";
import { del, invalidate, post, useApi } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { useDesk } from "../data";
import { closeTask, href, openTask } from "../router";
import { DECISION_STATUS_COLOR, RUN_STATUS_COLOR, STATUS_COLOR, fmtTokens, relTime } from "../format";
import type { Group, Project, TaskDetail } from "../types";
import { AgentViewLink, Avatar, Drawer, Empty, Icon, KeyChip, Markdown, Modal, Pill, PopoverButton, useAction, useToast } from "../components/ui";
import { DateCell, PersonCell, PersonPicker, PriorityCell, StatusCell, TypeCell, typeIcon } from "../components/cells";
import { NewTaskModal, useTaskUpdate } from "./Project";

type Tab = "updates" | "info" | "subtasks" | "activity";

export function TaskDrawer({ taskKey }: { taskKey: string }) {
  const { t, locale } = useI18n();
  const { data, error } = useApi<TaskDetail>(`/api/tasks/${encodeURIComponent(taskKey)}`);
  const project = useApi<{ project: Project; groups: Group[] }>(data ? `/api/projects/${data.task.project_key}` : null);
  const [tab, setTab] = useState<Tab>("updates");
  const update = useTaskUpdate();
  const run = useAction();
  const toast = useToast();
  const { actor } = useDesk();
  const [title, setTitle] = useState("");
  const [handoff, setHandoff] = useState(false);
  const [addSub, setAddSub] = useState(false);

  useEffect(() => {
    if (data) setTitle(data.task.title);
  }, [data?.task.title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <Drawer onClose={closeTask} label={taskKey}>
        <div className="drawer-body" style={{ paddingTop: 20 }}>
          <Empty>{t("task.notFound")}</Empty>
        </div>
      </Drawer>
    );
  }
  if (!data) return <Drawer onClose={closeTask} label={taskKey}>{null}</Drawer>;
  const { task } = data;
  const assignee = actor(task.assignee);
  const leaseHolder = actor(task.lease_holder);

  return (
    <Drawer onClose={closeTask} label={`${task.key} ${task.title}`}>
      <div className="drawer-head">
        <div className="crumbs">
          <a href={href(`/p/${task.project_key}`)}>{project.data?.project.name ?? task.project_key}</a>
          {task.parent_key && (
            <>
              <span>›</span>
              <button className="keychip" style={{ cursor: "pointer" }} onClick={() => openTask(task.parent_key!)}>
                {task.parent_key}
              </button>
            </>
          )}
          <span>›</span>
          <KeyChip>{task.key}</KeyChip>
          <span className="spacer" />
          <AgentViewLink href={`/api/tasks/${task.key}.md`} />
          <PopoverButton className="icon-btn" label={t("common.more")} button={<Icon name="more" />}>
            {(close) => (
              <div className="menu">
                <button
                  className="danger"
                  onClick={async () => {
                    close();
                    if (!confirm(t("common.confirmDelete"))) return;
                    const ok = await run(() => del(`/api/tasks/${task.key}`));
                    if (ok) {
                      invalidate();
                      closeTask();
                    }
                  }}
                >
                  <Icon name="trash" size={15} /> {t("task.delete")}
                </button>
              </div>
            )}
          </PopoverButton>
          <button className="icon-btn" onClick={closeTask} aria-label={t("common.close")}>
            <Icon name="close" />
          </button>
        </div>
        <input
          className="drawer-title"
          dir="auto"
          value={title}
          aria-label={t("col.task")}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && update(task.key, { title: title.trim() })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "10px 0 12px" }}>
          <div style={{ width: 150, borderRadius: 4, overflow: "hidden" }}>
            <StatusCell value={task.status} onChange={(v) => update(task.key, { status: v })} />
          </div>
          <PersonCell value={task.assignee} onChange={(v) => update(task.key, { assignee: v })} showName />
          <span style={{ flex: 1 }} />
          <button className="btn small" onClick={() => setHandoff(true)}>
            <Icon name="handoff" size={14} /> {t("task.handoff")}
          </button>
          {assignee?.kind === "agent" && (
            <button
              className="btn small"
              onClick={async () => {
                await run(() => post(`/api/actors/${assignee.id}/wake`, { task: task.key }));
                toast(t("task.woken"));
              }}
            >
              <Icon name="bolt" size={14} /> {t("task.wake")}
            </button>
          )}
        </div>
        {leaseHolder && (
          <div className="callout">
            <Icon name="lock" size={15} />
            <span>{t("task.claimedBy", { who: leaseHolder.name, until: new Date(task.lease_expires_at!).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })}</span>
          </div>
        )}
        {task.status === "blocked" && task.handoff_count > 0 && (
          <div className="callout warn">
            <Icon name="loop" size={15} />
            <span>{t("task.handoffs", { n: task.handoff_count })}</span>
          </div>
        )}
        <div className="tabs" role="tablist" style={{ marginBottom: 0 }}>
          {(
            [
              ["updates", t("task.updates"), data.comments.length],
              ["info", t("task.info"), 0],
              ["subtasks", t("task.subtasks"), data.subtasks.length],
              ["activity", t("task.activity"), 0],
            ] as Array<[Tab, string, number]>
          ).map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {label}
              {n > 0 && <span className="badge">{n}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="drawer-body" style={{ paddingTop: 16 }}>
        {tab === "updates" && <Updates detail={data} />}

        {tab === "info" && (
          <>
            <div className="props">
              <div className="k">{t("col.priority")}</div>
              <div className="v" style={{ maxWidth: 200 }}>
                <PriorityCell value={task.priority} onChange={(v) => update(task.key, { priority: v })} />
              </div>
              <div className="k">{t("col.type")}</div>
              <div className="v">
                <TypeCell value={task.type} onChange={(v) => update(task.key, { type: v })} />
              </div>
              <div className="k">{t("col.due")}</div>
              <div className="v">
                <DateCell value={task.due_at} status={task.status} onChange={(v) => update(task.key, { due_at: v })} />
              </div>
              <div className="k">{t("task.group")}</div>
              <div className="v">
                <select className="select" style={{ maxWidth: 220 }} value={task.group_id ?? ""} onChange={(e) => update(task.key, { group: e.target.value || null })}>
                  {(project.data?.groups ?? []).map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="k">{t("task.estimate")}</div>
              <div className="v">
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={1000}
                  style={{ maxWidth: 140 }}
                  defaultValue={task.estimate_tokens || ""}
                  key={task.estimate_tokens}
                  onBlur={(e) => Number(e.target.value) !== task.estimate_tokens && update(task.key, { estimate_tokens: Number(e.target.value) || 0 })}
                />
                <span style={{ color: "var(--text-2)", fontSize: 13 }}>
                  {t("task.used")}: {fmtTokens(task.tokens_used)}
                </span>
              </div>
              <div className="k">{t("task.reporter")}</div>
              <div className="v">
                <Avatar actor={actor(task.reporter)} size={22} /> {actor(task.reporter)?.name ?? "—"}
              </div>
              <div className="k">{t("task.blockedBy")}</div>
              <div className="v">
                {task.blocked_by.map((k) => (
                  <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                    <button className="keychip" style={{ cursor: "pointer" }} onClick={() => openTask(k)}>
                      {k}
                    </button>
                    <button
                      className="icon-btn"
                      style={{ width: 20, height: 20 }}
                      aria-label={`${t("common.delete")} ${k}`}
                      onClick={async () => {
                        await run(() => del(`/api/tasks/${task.key}/links/${k}`));
                        invalidate();
                      }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.namedItem("blocker") as HTMLInputElement;
                    const key = input.value.trim().toUpperCase();
                    if (!key) return;
                    const ok = await run(() => post(`/api/tasks/${task.key}/links`, { blocked_by: key }));
                    if (ok) {
                      input.value = "";
                      invalidate();
                    }
                  }}
                >
                  <input name="blocker" className="input" style={{ height: 28, width: 170 }} placeholder={t("task.addBlocker")} dir="ltr" />
                </form>
              </div>
              {task.blocks.length > 0 && (
                <>
                  <div className="k">{t("task.blocks")}</div>
                  <div className="v">
                    {task.blocks.map((k) => (
                      <button key={k} className="keychip" style={{ cursor: "pointer" }} onClick={() => openTask(k)}>
                        {k}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="k">{t("task.tags")}</div>
              <div className="v">
                <input
                  className="input"
                  style={{ maxWidth: 320 }}
                  defaultValue={task.tags.join(", ")}
                  key={task.tags.join(",")}
                  placeholder="frontend, urgent"
                  onBlur={(e) => {
                    const tags = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                    if (tags.join(",") !== task.tags.join(",")) update(task.key, { tags });
                  }}
                />
              </div>
            </div>
            <Description taskKey={task.key} value={task.description} />
            {data.decisions.length > 0 && (
              <>
                <h3 style={{ fontSize: 15 }}>{t("project.decisions")}</h3>
                {data.decisions.map((d) => (
                  <div key={d.id} className="callout" style={{ borderInlineStart: `4px solid ${DECISION_STATUS_COLOR[d.status]}` }}>
                    <div>
                      <strong>
                        {d.ref} · {d.title}
                      </strong>
                      <div>{d.decision}</div>
                      {d.rationale && <div style={{ color: "var(--text-3)" }}>{d.rationale}</div>}
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {tab === "subtasks" && (
          <>
            {data.subtasks.length === 0 && <Empty>{t("common.empty")}</Empty>}
            <div className="list" style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden", marginBottom: 12 }}>
              {data.subtasks.map((s) => (
                <div key={s.id} className="list-item" style={{ alignItems: "center", cursor: "default" }}>
                  <span>{typeIcon(s.type)}</span>
                  <button className="t" style={{ flex: 1, border: 0, background: "none", textAlign: "start", cursor: "pointer", padding: 0 }} onClick={() => openTask(s.key)}>
                    <KeyChip>{s.key}</KeyChip> {s.title}
                  </button>
                  <Avatar actor={actor(s.assignee)} size={22} />
                  <div style={{ width: 120, borderRadius: 4, overflow: "hidden" }}>
                    <StatusCell value={s.status} onChange={(v) => update(s.key, { status: v })} />
                  </div>
                </div>
              ))}
            </div>
            <button className="btn" onClick={() => setAddSub(true)}>
              <Icon name="plus" size={14} /> {t("task.addSubtask")}
            </button>
          </>
        )}

        {tab === "activity" && (
          <>
            {data.runs.length > 0 && (
              <>
                <h3 style={{ fontSize: 15, marginTop: 0 }}>{t("task.runs")}</h3>
                {data.runs.map((r) => (
                  <details key={r.id} className="run">
                    <summary>
                      <Pill color={RUN_STATUS_COLOR[r.status]}>{r.status}</Pill>
                      <Avatar actor={actor(r.actor)} size={20} />
                      <span>{r.trigger_type}</span>
                      <span style={{ color: "var(--text-3)" }}>{r.reason}</span>
                      <span style={{ marginInlineStart: "auto", color: "var(--text-3)", fontSize: 12 }}>{relTime(r.created_at, locale)}</span>
                    </summary>
                    {r.output && <pre dir="ltr">{r.output}</pre>}
                  </details>
                ))}
              </>
            )}
            <div className="timeline">
              {data.activity.map((a) => (
                <div key={a.id} className="tl-item">
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <Avatar actor={actor(a.actor)} size={18} />
                    <strong>{actor(a.actor)?.name ?? "Tunadesk"}</strong>
                    <span className="when">{relTime(a.created_at, locale)}</span>
                  </div>
                  <div>{a.summary}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {handoff && <HandoffModal detail={data} onClose={() => setHandoff(false)} />}
      {addSub && project.data && <NewTaskModal project={project.data.project} groups={project.data.groups} parent={task} onClose={() => setAddSub(false)} />}
    </Drawer>
  );
}

function Description({ taskKey, value }: { taskKey: string; value: string }) {
  const { t } = useI18n();
  const update = useTaskUpdate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
        {t("task.description")}
        {!editing && (
          <button
            className="btn small ghost"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
          >
            <Icon name="doc" size={13} /> {t("common.edit")}
          </button>
        )}
      </h3>
      {editing ? (
        <>
          <textarea className="textarea" dir="auto" style={{ minHeight: 160 }} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="btn primary small"
              onClick={async () => {
                await update(taskKey, { description: draft });
                setEditing(false);
              }}
            >
              {t("common.save")}
            </button>
            <button className="btn small" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </>
      ) : value ? (
        <Markdown text={value} />
      ) : (
        <button className="btn ghost" style={{ color: "var(--text-3)" }} onClick={() => setEditing(true)}>
          {t("task.descriptionEmpty")}
        </button>
      )}
    </div>
  );
}

function Updates({ detail }: { detail: TaskDetail }) {
  const { t, locale } = useI18n();
  const { actor } = useDesk();
  const { task, comments } = detail;
  return (
    <>
      {task.description && (
        <div className="update">
          <div className="update-head">
            <Avatar actor={actor(task.reporter)} size={24} />
            <strong>{actor(task.reporter)?.name ?? "—"}</strong>
            <span className="when">{relTime(task.created_at, locale)}</span>
          </div>
          <div className="update-body">
            <Markdown text={task.description} />
          </div>
        </div>
      )}
      <Composer taskKey={task.key} />
      {comments.length === 0 && <Empty>{t("task.noUpdates")}</Empty>}
      {[...comments].reverse().map((c) => (
        <div key={c.id} className={`update ${c.kind}`}>
          <div className="update-head">
            <Avatar actor={actor(c.author)} size={24} presence={actor(c.author)?.kind === "agent"} />
            <strong>{actor(c.author)?.name ?? c.author ?? "Tunadesk"}</strong>
            {c.kind !== "comment" && (
              <Pill color={c.kind === "handoff" ? "#44546a" : c.kind === "report" ? STATUS_COLOR.done : "#6e675c"} outline>
                {t(`task.kind.${c.kind}` as MessageKey)}
              </Pill>
            )}
            <span className="when" title={new Date(c.created_at).toLocaleString(locale)}>
              {relTime(c.created_at, locale)}
            </span>
          </div>
          <div className="update-body">
            <Markdown text={c.body} />
          </div>
        </div>
      ))}
    </>
  );
}

function Composer({ taskKey }: { taskKey: string }) {
  const { t } = useI18n();
  const run = useAction();
  const { actors } = useDesk();
  const [text, setText] = useState("");
  const [mention, setMention] = useState<string | null>(null);
  const [hl, setHl] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(
    () => (mention === null ? [] : actors.filter((a) => a.id.startsWith(mention.toLowerCase()) || a.name.toLowerCase().includes(mention.toLowerCase())).slice(0, 6)),
    [mention, actors],
  );

  const onChange = (v: string) => {
    setText(v);
    const caret = ref.current?.selectionStart ?? v.length;
    const m = /(^|\s)@([\w-]*)$/.exec(v.slice(0, caret));
    setMention(m ? m[2] : null);
    setHl(0);
  };
  const insert = (id: string) => {
    const caret = ref.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\w-]*)$/, `@${id} `);
    setText(before + text.slice(caret));
    setMention(null);
    ref.current?.focus();
  };
  const submit = async () => {
    if (!text.trim()) return;
    const ok = await run(() => post(`/api/tasks/${taskKey}/comments`, { body: text }));
    if (ok) {
      setText("");
      invalidate();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        dir="auto"
        value={text}
        placeholder={t("task.writeUpdate")}
        aria-label={t("task.writeUpdate")}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHl((h) => (h + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHl((h) => (h - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              insert(matches[hl].id);
              return;
            }
            if (e.key === "Escape") {
              setMention(null);
              return;
            }
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
        }}
      />
      {matches.length > 0 && (
        <div className="mention-list menu">
          {matches.map((a, i) => (
            <button key={a.id} className={i === hl ? "hl" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(a.id)}>
              <Avatar actor={a} size={22} /> {a.name} <span style={{ color: "var(--text-3)" }}>@{a.id}</span>
            </button>
          ))}
        </div>
      )}
      <div className="bar">
        <span>⌘/Ctrl + Enter</span>
        <button className="btn primary small" onClick={submit} disabled={!text.trim()}>
          <Icon name="send" size={13} /> {t("task.post")}
        </button>
      </div>
    </div>
  );
}

function HandoffModal({ detail, onClose }: { detail: TaskDetail; onClose: () => void }) {
  const { t } = useI18n();
  const run = useAction();
  const { actor } = useDesk();
  const [to, setTo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [subs, setSubs] = useState("");
  const target = actor(to);
  return (
    <Modal
      title={`${t("task.handoff")} · ${detail.task.key}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!to || !message.trim()}
            onClick={async () => {
              const subtasks = subs
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((title) => ({ title }));
              const ok = await run(() => post(`/api/tasks/${detail.task.key}/handoff`, { to, message, subtasks }));
              if (ok) {
                invalidate();
                onClose();
              }
            }}
          >
            <Icon name="handoff" size={14} /> {t("task.handoff")}
          </button>
        </>
      }
    >
      <div className="field">
        <span>{t("task.handoffTo")}</span>
        <PopoverButton className="btn" style={{ justifyContent: "flex-start" }} button={target ? <><Avatar actor={target} size={22} /> {target.name}</> : <>—</>} width={260}>
          {(close) => <PersonPicker value={to} onPick={setTo} close={close} allowNone={false} />}
        </PopoverButton>
      </div>
      <label className="field">
        <span>{t("task.handoffMessage")}</span>
        <textarea className="textarea" dir="auto" value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <label className="field">
        <span>{t("task.handoffBugs")}</span>
        <textarea className="textarea" dir="auto" rows={3} value={subs} onChange={(e) => setSubs(e.target.value)} />
      </label>
      {target?.kind === "agent" && target.trigger.enabled && (
        <div className="callout">
          <Icon name="bolt" size={15} />
          <span>{t(`agents.trigger.${target.trigger.type}` as MessageKey)}</span>
        </div>
      )}
    </Modal>
  );
}
