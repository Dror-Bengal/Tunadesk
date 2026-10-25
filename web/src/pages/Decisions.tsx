import { useState } from "react";
import { invalidate, patch, post, useApi } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { useDesk } from "../data";
import { href, openTask, useRoute } from "../router";
import { DECISION_STATUS_COLOR, relTime } from "../format";
import { DECISION_STATUSES, type Decision } from "../types";
import { AgentViewLink, Avatar, Empty, Icon, KeyChip, Markdown, Modal, Pill, useAction } from "../components/ui";

export function DecisionsPage() {
  const { t } = useI18n();
  const route = useRoute();
  const { projects } = useDesk();
  const [project, setProject] = useState("");
  const [q, setQ] = useState(route.query.get("q") ?? "");
  const [creating, setCreating] = useState(false);
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-header">
        <div>
          <h1>{t("decisions.title")}</h1>
          <p>{t("decisions.subtitle")}</p>
        </div>
        <span className="spacer" />
        <AgentViewLink href="/api/decisions?format=md" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} /> {t("decisions.new")}
        </button>
      </div>
      <div className="board-toolbar">
        <div className="search">
          <Icon name="search" size={15} />
          <input className="input" placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="select" style={{ width: 220 }} value={project} onChange={(e) => setProject(e.target.value)} aria-label={t("decisions.project")}>
          <option value="">{t("common.all")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.key}>
              {p.key} · {p.name}
            </option>
          ))}
        </select>
      </div>
      <DecisionList project={project || undefined} q={q} />
      {creating && <NewDecisionModal defaultProject={project} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function DecisionList({ project, q }: { project?: string; q?: string }) {
  const { t, locale } = useI18n();
  const { actor } = useDesk();
  const run = useAction();
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  const { data } = useApi<Decision[]>(`/api/decisions?${params}`);
  const list = (data ?? []).filter((d) => !q || `${d.ref} ${d.title} ${d.decision} ${d.rationale} ${d.context}`.toLowerCase().includes(q.toLowerCase()));
  if (!data) return null;
  if (!list.length) return <div className="card"><Empty>{t("decisions.empty")}</Empty></div>;
  const setStatus = async (d: Decision, status: Decision["status"]) => {
    await run(() => patch(`/api/decisions/${d.id}`, { status }));
    invalidate();
  };
  return (
    <div>
      {list.map((d) => (
        <article key={d.id} className="decision" style={{ ["--dc" as string]: DECISION_STATUS_COLOR[d.status] }}>
          <h3>
            <KeyChip>{d.ref}</KeyChip>
            <span dir="auto">{d.title}</span>
            <Pill color={DECISION_STATUS_COLOR[d.status]} outline>
              {t(`dstatus.${d.status}` as MessageKey)}
            </Pill>
            <span style={{ flex: 1 }} />
            {d.status === "proposed" && (
              <>
                <button className="btn small" onClick={() => setStatus(d, "accepted")}>
                  <Icon name="check" size={13} /> {t("decisions.accept")}
                </button>
                <button className="btn small ghost" onClick={() => setStatus(d, "rejected")}>
                  {t("decisions.reject")}
                </button>
              </>
            )}
          </h3>
          <div className="meta">
            <Avatar actor={actor(d.author)} size={18} />
            <span>{actor(d.author)?.name ?? d.author}</span>
            <span>·</span>
            <span title={new Date(d.created_at).toLocaleString(locale)}>{relTime(d.created_at, locale)}</span>
            {d.project_key && (
              <>
                <span>·</span>
                <a href={href(`/p/${d.project_key}`)}>{d.project_key}</a>
              </>
            )}
            {d.task_key && (
              <button className="keychip" style={{ cursor: "pointer" }} onClick={() => openTask(d.task_key!)}>
                {d.task_key}
              </button>
            )}
          </div>
          <dl>
            {d.context && (
              <>
                <dt>{t("decisions.context")}</dt>
                <dd>
                  <Markdown text={d.context} />
                </dd>
              </>
            )}
            <dt>{t("decisions.decision")}</dt>
            <dd>
              <Markdown text={d.decision} />
            </dd>
            {d.rationale && (
              <>
                <dt>{t("decisions.rationale")}</dt>
                <dd>
                  <Markdown text={d.rationale} />
                </dd>
              </>
            )}
            {d.alternatives && (
              <>
                <dt>{t("decisions.alternatives")}</dt>
                <dd>
                  <Markdown text={d.alternatives} />
                </dd>
              </>
            )}
          </dl>
        </article>
      ))}
    </div>
  );
}

function NewDecisionModal({ defaultProject, onClose }: { defaultProject: string; onClose: () => void }) {
  const { t } = useI18n();
  const run = useAction();
  const { projects } = useDesk();
  const [f, setF] = useState({ project: defaultProject, task: "", title: "", context: "", decision: "", rationale: "", alternatives: "", status: "accepted" as Decision["status"] });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      title={t("decisions.new")}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            disabled={!f.title.trim() || !f.decision.trim()}
            onClick={async () => {
              const ok = await run(() => post("/api/decisions", { ...f, project: f.project || null, task: f.task.trim().toUpperCase() || null }));
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
      <div className="field-row">
        <label className="field">
          <span>{t("decisions.project")}</span>
          <select className="select" value={f.project} onChange={(e) => set("project", e.target.value)}>
            <option value="">—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.key}>
                {p.key} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>
            {t("decisions.task")} <small>({t("common.optional")})</small>
          </span>
          <input className="input" dir="ltr" value={f.task} onChange={(e) => set("task", e.target.value)} placeholder="WEB-12" />
        </label>
      </div>
      <label className="field">
        <span>{t("common.name")}</span>
        <input className="input" dir="auto" autoFocus value={f.title} onChange={(e) => set("title", e.target.value)} />
      </label>
      <label className="field">
        <span>{t("decisions.context")}</span>
        <textarea className="textarea" dir="auto" rows={2} value={f.context} onChange={(e) => set("context", e.target.value)} />
      </label>
      <label className="field">
        <span>{t("decisions.decision")}</span>
        <textarea className="textarea" dir="auto" rows={2} value={f.decision} onChange={(e) => set("decision", e.target.value)} />
      </label>
      <label className="field">
        <span>{t("decisions.rationale")}</span>
        <textarea className="textarea" dir="auto" rows={2} value={f.rationale} onChange={(e) => set("rationale", e.target.value)} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>{t("decisions.alternatives")}</span>
          <textarea className="textarea" dir="auto" rows={2} value={f.alternatives} onChange={(e) => set("alternatives", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("project.status")}</span>
          <select className="select" value={f.status} onChange={(e) => set("status", e.target.value)}>
            {DECISION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`dstatus.${s}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}
