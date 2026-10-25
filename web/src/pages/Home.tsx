import { useEffect, useMemo, useState } from "react";
import { onActivity, useApi } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { useDesk } from "../data";
import { href, navigate, openTask } from "../router";
import { AGENT_STATUS_COLOR, DECISION_STATUS_COLOR, PROJECT_STATUS_COLOR, STATUS_COLOR, fmtTokens, relTime } from "../format";
import type { Activity, Notification, Overview, Task } from "../types";
import { AgentViewLink, Avatar, BudgetBar, Empty, Icon, KeyChip, Pill } from "../components/ui";

export function Home({ onNewProject }: { onNewProject: () => void }) {
  const { t } = useI18n();
  const desk = useDesk();
  const { data } = useApi<Overview>("/api/overview");
  const inbox = useApi<Notification[]>("/api/inbox?unread=1&limit=20");
  const reviewQueue = useApi<Task[]>(`/api/tasks?assignee=me&status=review,testing,blocked`);
  const ownerName = desk.me?.actor.name ?? "";

  if (!data) return <div className="page">{t("common.loading")}</div>;
  const s = data.by_status;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{ownerName && ownerName !== "Me" ? t("home.hello", { name: ownerName }) : t("home.helloAnon")}</h1>
          <p>{t("home.subtitle")}</p>
        </div>
        <span className="spacer" />
        <AgentViewLink href="/api/portfolio.md" />
        <button className="btn primary" onClick={onNewProject}>
          <Icon name="plus" size={15} /> {t("nav.newProject")}
        </button>
      </div>

      <div className="kpis">
        <Kpi color={STATUS_COLOR.in_progress} value={s.in_progress ?? 0} label={t("home.inProgress")} />
        <Kpi color={STATUS_COLOR.review} value={(s.review ?? 0) + (s.testing ?? 0)} label={t("home.inReview")} />
        <Kpi color={STATUS_COLOR.blocked} value={s.blocked ?? 0} label={t("home.blocked")} />
        <Kpi color="#7a3b5c" value={data.overdue} label={t("home.overdue")} />
        <Kpi color={STATUS_COLOR.done} value={data.done_this_week} label={t("home.doneWeek")} />
      </div>

      {data.projects.length === 0 ? (
        <div className="card" style={{ padding: 28, marginBottom: 16 }}>
          <h2 style={{ marginTop: 0 }}>{t("home.welcomeTitle")}</h2>
          <p style={{ color: "var(--text-2)" }}>{t("home.welcomeBody")}</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={onNewProject}>
              {t("nav.newProject")}
            </button>
            <a className="btn" href={href("/agents")}>
              {t("agents.new")}
            </a>
          </div>
          <p style={{ color: "var(--text-3)", fontSize: 13, marginBottom: 0 }}>{t("home.loadDemo")}</p>
        </div>
      ) : null}

      <div className="home-grid">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>{t("home.agentsNow")}</h2>
              <span className="spacer" />
              <a className="btn small ghost" href={href("/agents")}>
                {t("nav.agents")}
              </a>
            </div>
            <div className="card-body">
              {desk.agents.length ? (
                <div className="agent-strip">
                  {desk.agents.map((a) => {
                    const b = data.budgets.find((x) => x.actor === a.id);
                    return (
                      <button key={a.id} className="agent-mini" onClick={() => navigate(`/agents/${a.id}`)}>
                        <Avatar actor={a} size={34} presence />
                        <div className="meta">
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <strong>{a.name}</strong>
                            <Pill color={AGENT_STATUS_COLOR[a.status] ?? "#6e675c"} outline>
                              {t(`astatus.${a.status}` as MessageKey)}
                            </Pill>
                          </div>
                          <div className="note">{a.status_note || `@${a.id} · ${t(`role.${a.role}` as MessageKey)}`}</div>
                          <BudgetBar budget={b} compact />
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Empty>
                  <a href={href("/agents")}>{t("agents.new")}</a>
                </Empty>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>{t("home.projects")}</h2>
            </div>
            <div className="card-body">
              {data.projects.length ? (
                <div className="project-cards">
                  {data.projects.map((p) => {
                    const total = p.total_tasks ?? 0;
                    return (
                      <button key={p.id} className="project-card" style={{ ["--c" as string]: p.color }} onClick={() => navigate(`/p/${p.key}`)}>
                        <h3>
                          <span>{p.name}</span>
                          <KeyChip>{p.key}</KeyChip>
                          <span style={{ flex: 1 }} />
                          <Pill color={PROJECT_STATUS_COLOR[p.status]} outline>
                            {t(`pstatus.${p.status}` as MessageKey)}
                          </Pill>
                        </h3>
                        <p>{p.description || " "}</p>
                        <Battery counts={p.counts ?? {}} total={total} />
                        <div className="budget-label" style={{ marginTop: 6 }}>
                          <span>{t("project.open", { n: p.open_tasks ?? 0 })}</span>
                          <span>{t("project.items", { n: total })}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Empty>{t("home.noProjects")}</Empty>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>{t("home.usage")}</h2>
            </div>
            <UsageChart usage={data.usage} />
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>{t("home.needsYou")}</h2>
              <span className="spacer" />
              <a className="btn small ghost" href={href("/inbox")}>
                {t("nav.inbox")}
              </a>
            </div>
            <NeedsYou notifications={inbox.data ?? []} review={reviewQueue.data ?? []} decisions={data.recent_decisions.filter((d) => d.status === "proposed")} stale={data.stale ?? []} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>{t("home.activity")}</h2>
            </div>
            <ActivityFeed initial={data.activity} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>{t("home.decisions")}</h2>
              <span className="spacer" />
              <a className="btn small ghost" href={href("/decisions")}>
                {t("nav.decisions")}
              </a>
            </div>
            <div className="list">
              {data.recent_decisions.slice(0, 5).map((d) => (
                <a key={d.id} className="list-item" href={href("/decisions", { q: d.ref })} style={{ textDecoration: "none", color: "inherit" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 4, background: DECISION_STATUS_COLOR[d.status], marginTop: 7, flex: "none" }} />
                  <div className="body">
                    <div className="title">{d.title}</div>
                    <div className="sub">
                      <KeyChip>{d.ref}</KeyChip> {d.decision}
                    </div>
                  </div>
                </a>
              ))}
              {!data.recent_decisions.length && <Empty>{t("decisions.empty")}</Empty>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Kpi({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="kpi" style={{ ["--c" as string]: color }}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function Battery({ counts, total }: { counts: Record<string, number>; total: number }) {
  const order = ["done", "in_progress", "review", "testing", "blocked", "todo", "backlog", "canceled"] as const;
  return (
    <div className="battery" aria-hidden="true">
      {total > 0 && order.map((s) => (counts[s] ? <i key={s} style={{ width: `${(counts[s] / total) * 100}%`, background: STATUS_COLOR[s] }} title={`${s}: ${counts[s]}`} /> : null))}
    </div>
  );
}

function NeedsYou({ notifications, review, decisions, stale }: { notifications: Notification[]; review: Task[]; decisions: Overview["recent_decisions"]; stale: Overview["stale"] }) {
  const { t, locale } = useI18n();
  const { actor } = useDesk();
  const items = [
    ...stale.map((task) => ({
      id: `stale-${task.id}`,
      icon: "clock",
      title: `${task.key} · ${task.title}`,
      sub: t("home.stale", { who: actor(task.assignee)?.name ?? task.assignee ?? "—", n: task.idle_hours >= 48 ? t("home.days", { n: Math.floor(task.idle_hours / 24) }) : t("home.hours", { n: task.idle_hours }) }),
      when: task.updated_at,
      go: () => openTask(task.key),
      unread: true,
    })),
    ...decisions.map((d) => ({
      id: d.id,
      icon: "scale",
      title: d.title,
      sub: `${t("home.proposed")} · ${d.ref}`,
      when: d.created_at,
      go: () => navigate("/decisions", { q: d.ref }),
      unread: true,
    })),
    ...review.map((task) => ({
      id: task.id,
      icon: task.status === "blocked" ? "alert" : "eye",
      title: `${task.key} · ${task.title}`,
      sub: task.status === "blocked" ? t("status.blocked") : t("home.review"),
      when: task.updated_at,
      go: () => openTask(task.key),
      unread: true,
    })),
    ...notifications.filter((n) => !n.task_id || !review.some((r) => r.id === n.task_id)).map((n) => ({
      id: n.id,
      icon: n.type === "loop_guard" ? "loop" : n.type === "run_failed" || n.type === "budget" ? "alert" : "bell",
      title: `${actor(n.sender)?.name ?? n.sender ?? "Tunadesk"} ${t(`notif.${n.type}` as MessageKey)}${n.task_key ? ` · ${n.task_key}` : ""}`,
      sub: n.message,
      when: n.created_at,
      go: () => (n.task_key ? openTask(n.task_key) : navigate("/inbox")),
      unread: !n.read_at,
    })),
  ].slice(0, 12);
  if (!items.length) return <Empty>{t("home.needsYouEmpty")}</Empty>;
  return (
    <div className="list">
      {items.map((i) => (
        <button key={i.id} className={`list-item${i.unread ? " unread" : ""}`} onClick={i.go}>
          <span className="needs-icon"><Icon name={i.icon} size={15} /></span>
          <div className="body">
            <div className="title">{i.title}</div>
            <div className="sub">{i.sub}</div>
          </div>
          <span className="when">{relTime(i.when, locale)}</span>
        </button>
      ))}
    </div>
  );
}

export function ActivityFeed({ initial, limit = 25 }: { initial: Activity[]; limit?: number }) {
  const { locale } = useI18n();
  const { actor } = useDesk();
  const [fresh, setFresh] = useState<Set<number>>(new Set());
  useEffect(
    () =>
      onActivity((a) => {
        setFresh((f) => new Set(f).add(a.id));
        setTimeout(() => setFresh((f) => {
          const n = new Set(f);
          n.delete(a.id);
          return n;
        }), 1800);
      }),
    [],
  );
  const items = initial.slice(0, limit);
  if (!items.length) return <Empty>—</Empty>;
  return (
    <div className="list" style={{ paddingBottom: 8 }}>
      {items.map((a) => (
        <div key={a.id} className={`feed-item${fresh.has(a.id) ? " fresh" : ""}`}>
          <Avatar actor={actor(a.actor)} size={22} />
          <div style={{ minWidth: 0 }}>
            {a.task_key ? (
              <button className="t" onClick={() => openTask(a.task_key!)} style={{ border: 0, background: "none", padding: 0, cursor: "pointer", textAlign: "start", color: "inherit" }}>
                {a.summary}
              </button>
            ) : (
              a.summary
            )}
          </div>
          <span className="when">{relTime(a.created_at, locale)}</span>
        </div>
      ))}
    </div>
  );
}

function UsageChart({ usage }: { usage: Overview["usage"] }) {
  const { locale } = useI18n();
  const { actor } = useDesk();
  const { days, actors, max } = useMemo(() => {
    const days: string[] = [];
    for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
    const actors = [...new Set(usage.map((u) => u.actor))];
    const totals = days.map((d) => usage.filter((u) => u.day === d).reduce((s, u) => s + u.tokens, 0));
    return { days, actors, max: Math.max(1, ...totals) };
  }, [usage]);
  if (!usage.length) return <Empty>—</Empty>;
  const W = 640;
  const H = 180;
  const pad = { l: 40, r: 8, t: 8, b: 22 };
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Token usage per day" style={{ padding: "0 8px" }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" />
            <text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end" fontSize="10" fill="var(--text-3)">
              {fmtTokens(Math.round(max * f))}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          let acc = 0;
          return (
            <g key={d}>
              {actors.map((a) => {
                const v = usage.find((u) => u.day === d && u.actor === a)?.tokens ?? 0;
                if (!v) return null;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                return (
                  <rect key={a} x={pad.l + i * bw + 3} width={bw - 6} y={y1} height={Math.max(0, y0 - y1)} rx={2} fill={actor(a)?.color ?? "#6e675c"}>
                    <title>{`${actor(a)?.name ?? a} · ${d}: ${fmtTokens(v)}`}</title>
                  </rect>
                );
              })}
              {i % 2 === 0 && (
                <text x={pad.l + i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-3)">
                  {new Date(d).toLocaleDateString(locale, { day: "numeric", month: "numeric" })}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="legend">
        {actors.map((a) => (
          <span key={a}>
            <i style={{ background: actor(a)?.color ?? "#6e675c" }} />
            {actor(a)?.name ?? a}
          </span>
        ))}
      </div>
    </>
  );
}
