import { useState } from "react";
import { invalidate, post, useApi } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { useDesk } from "../data";
import { navigate, openTask } from "../router";
import { relTime } from "../format";
import type { Notification, Task } from "../types";
import { AgentViewLink, Avatar, Empty, Icon, KeyChip, Markdown } from "../components/ui";
import { DateCell, PriorityCell, StatusCell, typeIcon } from "../components/cells";
import { useTaskUpdate } from "./Project";

export function InboxPage() {
  const { t, locale } = useI18n();
  const { actor } = useDesk();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data } = useApi<Notification[]>(`/api/inbox?limit=200${unreadOnly ? "&unread=1" : ""}`);
  const markRead = async (ids: string[] | "all") => {
    await post("/api/inbox/read", { ids });
    invalidate();
  };
  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-header">
        <div>
          <h1>{t("inbox.title")}</h1>
        </div>
        <span className="spacer" />
        <AgentViewLink href="/api/inbox?format=md" />
        <div className="segmented">
          <button className={!unreadOnly ? "active" : ""} onClick={() => setUnreadOnly(false)}>
            {t("common.all")}
          </button>
          <button className={unreadOnly ? "active" : ""} onClick={() => setUnreadOnly(true)}>
            {t("common.unread")}
          </button>
        </div>
        <button className="btn" onClick={() => markRead("all")}>
          <Icon name="check" size={15} /> {t("inbox.markAll")}
        </button>
      </div>
      <div className="card">
        {!data?.length ? (
          <Empty icon="📭">{t("inbox.empty")}</Empty>
        ) : (
          <div className="list">
            {data.map((n) => {
              const sender = actor(n.sender);
              return (
                <button
                  key={n.id}
                  className={`list-item${n.read_at ? "" : " unread"}`}
                  onClick={() => {
                    if (!n.read_at) void markRead([n.id]);
                    if (n.task_key) openTask(n.task_key);
                  }}
                >
                  {sender ? <Avatar actor={sender} size={32} /> : <span style={{ fontSize: 22, width: 32, textAlign: "center" }}>{n.type === "loop_guard" ? "🔁" : n.type === "budget" ? "💸" : "🐟"}</span>}
                  <div className="body">
                    <div className="title">
                      {sender?.name ?? "Tunadesk"} <span style={{ fontWeight: 400, color: "var(--text-2)" }}>{t(`notif.${n.type}` as MessageKey)}</span>{" "}
                      {n.task_key && <KeyChip>{n.task_key}</KeyChip>} {n.task_title}
                    </div>
                    {n.message && (
                      <div className="sub" style={{ WebkitLineClamp: 3 }}>
                        <Markdown text={n.message} />
                      </div>
                    )}
                  </div>
                  <span className="when">{relTime(n.created_at, locale)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function MyWorkPage() {
  const { t } = useI18n();
  const { me, project } = useDesk();
  const { data } = useApi<Task[]>("/api/tasks?assignee=me&limit=500");
  const update = useTaskUpdate();
  const tasks = data ?? [];
  const byProject = new Map<string, Task[]>();
  for (const x of tasks) byProject.set(x.project_key, [...(byProject.get(x.project_key) ?? []), x]);
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-header">
        <div>
          <h1>{t("mywork.title")}</h1>
          <p>
            <Avatar actor={me?.actor} size={20} /> {me?.actor.name}
          </p>
        </div>
      </div>
      {!tasks.length && (
        <div className="card">
          <Empty icon="🏖️">{t("mywork.empty")}</Empty>
        </div>
      )}
      {[...byProject.entries()].map(([key, list]) => {
        const p = project(key);
        return (
          <section key={key} className="group" style={{ ["--gc" as string]: p?.color ?? "#579bfc" }}>
            <div className="group-head">
              <h3 style={{ cursor: "pointer" }} onClick={() => navigate(`/p/${key}`)}>
                {p?.name ?? key}
              </h3>
              <span className="count">{t("project.items", { n: list.length })}</span>
            </div>
            <div className="table-wrap">
              <div className="table" style={{ gridTemplateColumns: "minmax(300px,3fr) 150px 120px 110px", minWidth: 680 }}>
                {list.map((task) => (
                  <div className="row" key={task.id}>
                    <div className="td title-cell">
                      <span>{typeIcon(task.type)}</span>
                      <button className="t" onClick={() => openTask(task.key)}>
                        {task.title}
                      </button>
                      <span className="keychip">{task.key}</span>
                    </div>
                    <div className="td">
                      <StatusCell value={task.status} onChange={(v) => update(task.key, { status: v })} />
                    </div>
                    <div className="td">
                      <PriorityCell value={task.priority} onChange={(v) => update(task.key, { priority: v })} />
                    </div>
                    <div className="td">
                      <DateCell value={task.due_at} status={task.status} onChange={(v) => update(task.key, { due_at: v })} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
