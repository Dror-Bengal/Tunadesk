import { useEffect, useState } from "react";
import { invalidate, patch, post, useApi } from "../api";
import { useI18n, type MessageKey } from "../i18n";
import { useDesk } from "../data";
import { navigate, openTask } from "../router";
import { AGENT_STATUS_COLOR, PALETTE, PLATFORM_LABEL, RUN_STATUS_COLOR, relTime } from "../format";
import { PLATFORMS, ROLES, TRIGGER_TYPES, WAKE_TYPES, type Actor, type AgentDetail, type Snippet, type TriggerConfig } from "../types";
import { Avatar, BudgetBar, CopyButton, Empty, Icon, KeyChip, Modal, Pill, useAction, useToast } from "../components/ui";
import { ActivityFeed } from "./Home";

export function AgentsPage({ agentId }: { agentId?: string }) {
  const { t, locale } = useI18n();
  const { actors } = useDesk();
  const [creating, setCreating] = useState(false);
  if (agentId) return <AgentDetailPage id={agentId} />;
  const agents = actors.filter((a) => a.kind === "agent");
  const humans = actors.filter((a) => a.kind === "human");
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{t("agents.title")}</h1>
          <p>{t("agents.subtitle")}</p>
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} /> {t("agents.new")}
        </button>
      </div>
      {agents.length === 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <Empty>
            <button className="btn primary" onClick={() => setCreating(true)}>
              {t("agents.new")}
            </button>
          </Empty>
        </div>
      )}
      <div className="agent-cards">
        {agents.map((a) => (
          <button key={a.id} className="agent-card" onClick={() => navigate(`/agents/${a.id}`)}>
            <div className="head">
              <Avatar actor={a} size={44} presence />
              <div style={{ minWidth: 0 }}>
                <h3>{a.name}</h3>
                <div className="handle">@{a.id}</div>
              </div>
              <span style={{ flex: 1 }} />
              {a.unread ? <span className="pill" style={{ background: "var(--danger)", color: "#fff" }}>{a.unread}</span> : null}
            </div>
            <div className="row">
              <Pill color={a.color} outline>
                {PLATFORM_LABEL[a.platform] ?? a.platform}
              </Pill>
              <Pill color="#57534c" outline>
                {t(`role.${a.role}` as MessageKey)}
              </Pill>
              <Pill color={AGENT_STATUS_COLOR[a.status] ?? "#6e675c"} outline>
                {t(`astatus.${a.status}` as MessageKey)}
              </Pill>
              {a.runners?.length ? (
                <Pill color="#2f6b4f" outline>
                  <Icon name="link" size={12} /> {a.runners[0].name}
                </Pill>
              ) : null}
              {a.trigger.enabled && a.trigger.type !== "none" && (
                <Pill color="#44546a" outline>
                  <Icon name="bolt" size={12} /> {a.trigger.type}
                </Pill>
              )}
            </div>
            <div className="note">{a.status_note || t("agents.lastSeen", { when: a.last_seen_at ? relTime(a.last_seen_at, locale) : t("agents.never") })}</div>
            <BudgetBar budget={a.budget} />
          </button>
        ))}
      </div>
      {humans.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, margin: "28px 0 12px" }}>{t("agents.humans")}</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {humans.map((h) => (
              <div key={h.id} className="card" style={{ padding: "10px 14px", display: "flex", gap: 10, alignItems: "center" }}>
                <Avatar actor={h} size={30} />
                <div>
                  <strong>{h.name}</strong>
                  <div style={{ color: "var(--text-3)", fontSize: 12 }}>@{h.id}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {creating && <NewAgentModal onClose={() => setCreating(false)} />}
    </div>
  );
}

const PLATFORM_DEFAULTS: Record<string, { emoji: string; trigger: TriggerConfig["type"]; color: string }> = {
  "claude-code": { emoji: "🧠", trigger: "claude", color: "#8c4a2f" },
  codex: { emoji: "🧪", trigger: "codex", color: "#2f6b4f" },
  grok: { emoji: "🔭", trigger: "grok", color: "#6b4a8a" },
  chatgpt: { emoji: "💬", trigger: "webhook", color: "#2d6a6a" },
  cursor: { emoji: "🖱️", trigger: "none", color: "#44546a" },
  gemini: { emoji: "✨", trigger: "command", color: "#a8661c" },
  other: { emoji: "🤖", trigger: "none", color: "#4e4a8c" },
  human: { emoji: "🧑", trigger: "none", color: "#8c4a2f" },
};

function NewAgentModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const run = useAction();
  const [f, setF] = useState({ name: "", id: "", platform: "claude-code", role: "developer", emoji: "🧠", color: "#8c4a2f", token_budget: 0, budget_period: "day", description: "" });
  const [created, setCreated] = useState<{ actor: Actor; token: string } | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  if (created) {
    return (
      <Modal title={`${created.actor.emoji} ${created.actor.name}`} onClose={onClose} wide footer={<button className="btn primary" onClick={() => { onClose(); navigate(`/agents/${created.actor.id}`); }}>{t("common.open")}</button>}>
        <TokenBox token={created.token} />
        <ConnectSnippets agentId={created.actor.id} token={created.token} />
      </Modal>
    );
  }

  const submit = async () => {
    const d = PLATFORM_DEFAULTS[f.platform] ?? PLATFORM_DEFAULTS.other;
    const res = await run(() =>
      post<{ actor: Actor; token: string }>("/api/actors", {
        ...f,
        id: f.id || undefined,
        kind: f.platform === "human" ? "human" : "agent",
        trigger: { type: d.trigger, enabled: false },
      }),
    );
    if (res) {
      invalidate();
      if (res.token) setCreated(res);
      else onClose();
    }
  };

  return (
    <Modal
      title={t("agents.new")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={!f.name.trim()} onClick={submit}>
            {t("common.create")}
          </button>
        </>
      }
    >
      <div className="field-row">
        <label className="field">
          <span>{t("common.name")}</span>
          <input
            className="input"
            autoFocus
            value={f.name}
            placeholder="Claude Dev"
            onChange={(e) => {
              set("name", e.target.value);
              set("id", e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
            }}
          />
        </label>
        <label className="field">
          <span>{t("agents.id")}</span>
          <input className="input" dir="ltr" value={f.id} onChange={(e) => set("id", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>{t("agents.platform")}</span>
          <select
            className="select"
            value={f.platform}
            onChange={(e) => {
              const d = PLATFORM_DEFAULTS[e.target.value] ?? PLATFORM_DEFAULTS.other;
              setF((x) => ({ ...x, platform: e.target.value, emoji: d.emoji, color: d.color }));
            }}
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("agents.role")}</span>
          <select className="select" value={f.role} onChange={(e) => set("role", e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>{t("agents.budget")}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="input" type="number" min={0} step={10000} value={f.token_budget || ""} placeholder={t("agents.unlimited")} onChange={(e) => set("token_budget", Number(e.target.value) || 0)} />
            <select className="select" style={{ width: 110 }} value={f.budget_period} onChange={(e) => set("budget_period", e.target.value)} aria-label={t("agents.period")}>
              {(["day", "week", "month"] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`agents.period.${p}`)}
                </option>
              ))}
            </select>
          </div>
        </label>
        <div className="field">
          <span>
            {t("agents.emoji")} / {t("project.color")}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input className="input" style={{ width: 60, textAlign: "center" }} value={f.emoji} maxLength={8} onChange={(e) => set("emoji", e.target.value)} />
            {PALETTE.slice(0, 7).map((c) => (
              <button key={c} type="button" aria-label={c} onClick={() => set("color", c)} style={{ width: 20, height: 20, borderRadius: 5, background: c, border: c === f.color ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer" }} />
            ))}
          </div>
        </div>
      </div>
      <label className="field">
        <span>{t("agents.instructions")}</span>
        <textarea className="textarea" dir="auto" rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} />
        <small>{t("agents.instructionsHint")}</small>
      </label>
    </Modal>
  );
}

function TokenBox({ token }: { token: string }) {
  const { t } = useI18n();
  return (
    <>
      <div className="callout warn">
        <Icon name="key" size={16} />
        <span>{t("agents.tokenShown")}</span>
      </div>
      <div className="token-box">
        <code dir="ltr">{token}</code>
        <CopyButton text={token} small />
      </div>
    </>
  );
}

function ConnectSnippets({ agentId, token }: { agentId: string; token?: string }) {
  const { t } = useI18n();
  const { data } = useApi<Snippet[]>(`/api/actors/${agentId}/connect`);
  return (
    <div>
      <p style={{ color: "var(--text-2)", marginTop: 0 }}>{t("agents.connectHint")}</p>
      {(data ?? []).map((s) => {
        const code = token ? s.code.replaceAll("<AGENT_TOKEN>", token) : s.code;
        return (
          <div key={s.id} className="snippet">
            <div className="snippet-head">
              <h4>{s.title}</h4>
              <CopyButton text={code} small />
            </div>
            <p>{s.description}</p>
            <pre dir="ltr">{code}</pre>
          </div>
        );
      })}
    </div>
  );
}

type AgentTab = "overview" | "trigger" | "connect" | "runs";

function AgentDetailPage({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const run = useAction();
  const toast = useToast();
  const { data, error } = useApi<AgentDetail>(`/api/actors/${id}`);
  const [tab, setTab] = useState<AgentTab>("overview");
  const [token, setToken] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  if (error) return <div className="page"><Empty>{error}</Empty></div>;
  if (!data) return <div className="page">{t("common.loading")}</div>;
  const a = data.actor;
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-header">
        <button className="icon-btn" onClick={() => navigate("/agents")} aria-label={t("agents.title")}>
          <Icon name="chevron" size={18} className="back" />
        </button>
        <Avatar actor={a} size={52} presence />
        <div>
          <h1>{a.name}</h1>
          <p style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <KeyChip>@{a.id}</KeyChip>
            <Pill color={a.color} outline>
              {PLATFORM_LABEL[a.platform] ?? a.platform}
            </Pill>
            <Pill color="#57534c" outline>
              {t(`role.${a.role}` as MessageKey)}
            </Pill>
            <Pill color={AGENT_STATUS_COLOR[a.status] ?? "#6e675c"}>{t(`astatus.${a.status}` as MessageKey)}</Pill>
            <span style={{ color: "var(--text-3)", fontSize: 13 }}>{a.status_note || t("agents.lastSeen", { when: a.last_seen_at ? relTime(a.last_seen_at, locale) : t("agents.never") })}</span>
          </p>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => setEditing(true)}>
          <Icon name="doc" size={14} /> {t("common.edit")}
        </button>
        <button
          className="btn primary"
          onClick={async () => {
            await run(() => post(`/api/actors/${a.id}/wake`, {}));
            toast(t("task.woken"));
          }}
        >
          <Icon name="bolt" size={14} /> {t("agents.wake")}
        </button>
      </div>

      {a.trigger.type !== "none" && a.trigger.type !== "webhook" && (
        <div className={`callout${data.runners.length || a.trigger.where === "desk" ? "" : " warn"}`}>
          <Icon name="link" size={15} />
          <span>
            {data.runners.length
              ? t("agents.runnerOnline", { name: data.runners.map((r) => `${r.name} · ${relTime(r.since, locale)}`).join(", ") })
              : `${t("agents.runnerOffline")} — ${t("agents.runnerHint")}`}
          </span>
        </div>
      )}

      <div className="tabs" role="tablist">
        {(
          [
            ["overview", t("agents.overview")],
            ["trigger", t("agents.trigger")],
            ["connect", t("agents.connect")],
            ["runs", t("agents.runs")],
          ] as Array<[AgentTab, string]>
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
            {label}
            {k === "runs" && data.runs.length > 0 && <span className="badge">{data.runs.length}</span>}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="home-grid">
          <div className="stack">
            <section className="card">
              <div className="card-head">
                <h2>{t("agents.queue")}</h2>
              </div>
              <div className="card-body">
                {data.next.length === 0 && <Empty>{t("agents.queueEmpty")}</Empty>}
                {data.next.map((r) => (
                  <div key={r.task.id} className="rec">
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span className="score">{r.score}</span>
                      <button className="keychip" style={{ cursor: "pointer" }} onClick={() => openTask(r.task.key)}>
                        {r.task.key}
                      </button>
                      <span style={{ flex: 1 }}>{r.task.title}</span>
                      {r.over_budget && <Pill color="#9e2f3a" outline><Icon name="alert" size={12} /></Pill>}
                    </div>
                    <div className="reasons">{r.reasons.join(" · ")}</div>
                  </div>
                ))}
              </div>
            </section>
            <section className="card">
              <div className="card-head">
                <h2>{t("agents.tasks")}</h2>
              </div>
              <div className="list">
                {data.tasks.map((task) => (
                  <button key={task.id} className="list-item" onClick={() => openTask(task.key)}>
                    <KeyChip>{task.key}</KeyChip>
                    <div className="body">{task.title}</div>
                    <Pill color="#57534c" outline>
                      {t(`status.${task.status}` as MessageKey)}
                    </Pill>
                  </button>
                ))}
                {!data.tasks.length && <Empty>{t("common.empty")}</Empty>}
              </div>
            </section>
          </div>
          <div className="stack">
            <section className="card">
              <div className="card-head">
                <h2>{t("agents.budget")}</h2>
              </div>
              <div className="card-body">
                <BudgetBar budget={data.budget} />
              </div>
            </section>
            {a.description && (
              <section className="card">
                <div className="card-head">
                  <h2>{t("agents.instructions")}</h2>
                </div>
                <div className="card-body" dir="auto">
                  {a.description}
                </div>
              </section>
            )}
            <section className="card">
              <div className="card-head">
                <h2>{t("home.activity")}</h2>
              </div>
              <ActivityFeed initial={data.activity} />
            </section>
          </div>
        </div>
      )}

      {tab === "trigger" && <TriggerForm actor={a} />}

      {tab === "connect" && (
        <div className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>{t("agents.token")}</h3>
          {token ? (
            <TokenBox token={token} />
          ) : (
            <button
              className="btn"
              style={{ marginBottom: 16 }}
              onClick={async () => {
                if (!confirm(t("agents.rotateConfirm"))) return;
                const res = await run(() => post<{ token: string }>(`/api/actors/${a.id}/token`, {}));
                if (res) setToken(res.token);
              }}
            >
              <Icon name="key" size={14} /> {t("agents.rotate")}
            </button>
          )}
          <ConnectSnippets agentId={a.id} token={token ?? undefined} />
        </div>
      )}

      {tab === "runs" && (
        <div>
          {data.runs.length === 0 && (
            <div className="card">
              <Empty>{t("agents.noRuns")}</Empty>
            </div>
          )}
          {data.runs.map((r) => (
            <details key={r.id} className="run card">
              <summary>
                <Pill color={RUN_STATUS_COLOR[r.status]}>{r.status}</Pill>
                <span>{r.trigger_type}</span>
                {r.task_key && (
                  <button className="keychip" style={{ cursor: "pointer" }} onClick={(e) => { e.preventDefault(); openTask(r.task_key!); }}>
                    {r.task_key}
                  </button>
                )}
                <span style={{ color: "var(--text-3)" }}>{r.reason}</span>
                {r.exit_code !== null && <span className="score">exit {r.exit_code}</span>}
                <span style={{ marginInlineStart: "auto", color: "var(--text-3)", fontSize: 12 }}>{relTime(r.created_at, locale)}</span>
              </summary>
              {r.output ? <pre dir="ltr">{r.output}</pre> : null}
            </details>
          ))}
        </div>
      )}

      {editing && <EditAgentModal actor={a} onClose={() => setEditing(false)} />}
    </div>
  );
}

function TriggerForm({ actor }: { actor: Actor }) {
  const { t } = useI18n();
  const run = useAction();
  const [f, setF] = useState<TriggerConfig>(actor.trigger);
  const [args, setArgs] = useState((actor.trigger.args ?? []).join("\n"));
  useEffect(() => {
    setF(actor.trigger);
    setArgs((actor.trigger.args ?? []).join("\n"));
  }, [actor.trigger]);
  const set = <K extends keyof TriggerConfig>(k: K, v: TriggerConfig[K]) => setF((x) => ({ ...x, [k]: v }));
  const on = f.on?.length ? f.on : [...WAKE_TYPES];
  const cli = f.type === "claude" || f.type === "codex" || f.type === "grok" || f.type === "command";
  return (
    <div className="card" style={{ padding: 18, maxWidth: 760 }}>
      <div className="callout">
        <Icon name="bolt" size={16} />
        <span>{t("agents.triggerHelp")}</span>
      </div>
      <label className="field">
        <span>{t("agents.triggerType")}</span>
        <select className="select" value={f.type} onChange={(e) => set("type", e.target.value as TriggerConfig["type"])}>
          {TRIGGER_TYPES.map((k) => (
            <option key={k} value={k}>
              {t(`agents.trigger.${k}` as MessageKey)}
            </option>
          ))}
        </select>
      </label>
      {f.type !== "none" && f.type !== "webhook" && (
        <label className="field">
          <span>{t("agents.where")}</span>
          <select className="select" value={f.where ?? "auto"} onChange={(e) => set("where", e.target.value as TriggerConfig["where"])}>
            {(["auto", "desk", "remote"] as const).map((w) => (
              <option key={w} value={w}>
                {t(`agents.where.${w}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {f.type !== "none" && (
        <>
          <label className="check">
            <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            {t("agents.triggerEnabled")}
          </label>
          <div className="field">
            <span>{t("agents.triggerOn")}</span>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {WAKE_TYPES.map((w) => (
                <label key={w} className="check" style={{ margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={on.includes(w)}
                    onChange={(e) => set("on", e.target.checked ? [...on, w] : on.filter((x) => x !== w))}
                  />
                  {t(`notif.${w}` as MessageKey)}
                </label>
              ))}
            </div>
          </div>
          {cli && (
            <>
              <div className="field-row">
                <label className="field">
                  <span>
                    {t("agents.triggerCommand")} {f.type !== "command" && <small>({t("common.optional")})</small>}
                  </span>
                  <input className="input" dir="ltr" value={f.command ?? ""} placeholder={f.type === "command" ? "/usr/local/bin/my-agent" : f.type} onChange={(e) => set("command", e.target.value || undefined)} />
                </label>
                {f.type !== "command" && (
                  <label className="field">
                    <span>{t("agents.triggerModel")}</span>
                    <input className="input" dir="ltr" value={f.model ?? ""} placeholder={f.type === "claude" ? "sonnet" : ""} onChange={(e) => set("model", e.target.value || undefined)} />
                  </label>
                )}
              </div>
              <label className="field">
                <span>{t("agents.triggerArgs")}</span>
                <textarea
                  className="textarea"
                  dir="ltr"
                  rows={3}
                  value={args}
                  placeholder={f.type === "claude" ? "--permission-mode\nacceptEdits" : f.type === "codex" ? "--full-auto" : f.type === "command" ? "--prompt\n{prompt}" : ""}
                  onChange={(e) => setArgs(e.target.value)}
                />
                <small dir="ltr">{"{prompt} {task} {actor} {url} {mcp_url} {cwd} {notification}"}</small>
              </label>
              <label className="field">
                <span>{t("agents.triggerCwd")}</span>
                <input className="input" dir="ltr" value={f.cwd ?? ""} placeholder={t("project.repoPath")} onChange={(e) => set("cwd", e.target.value || undefined)} />
              </label>
            </>
          )}
          {f.type === "webhook" && (
            <div className="field-row">
              <label className="field">
                <span>{t("agents.triggerUrl")}</span>
                <input className="input" dir="ltr" value={f.url ?? ""} placeholder="https://n8n.example.com/webhook/agent" onChange={(e) => set("url", e.target.value || undefined)} />
              </label>
              <label className="field">
                <span>{t("agents.triggerSecret")}</span>
                <input className="input" dir="ltr" type="password" value={f.secret ?? ""} placeholder={f.has_secret ? "•••••••• (saved)" : ""} onChange={(e) => set("secret", e.target.value || undefined)} />
              </label>
            </div>
          )}
          <div className="field-row">
            <label className="field">
              <span>{t("agents.triggerTimeout")}</span>
              <input className="input" type="number" min={1} max={1440} value={f.timeout_minutes ?? 30} onChange={(e) => set("timeout_minutes", Number(e.target.value) || 30)} />
            </label>
            <label className="check" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={f.respect_budget !== false} onChange={(e) => set("respect_budget", e.target.checked)} />
              {t("agents.triggerBudget")}
            </label>
          </div>
        </>
      )}
      <button
        className="btn primary"
        onClick={async () => {
          const trigger = { ...f, args: args.split("\n").map((s) => s.trim()).filter(Boolean) };
          await run(() => patch(`/api/actors/${actor.id}`, { trigger }), t("settings.saved"));
          invalidate();
        }}
      >
        {t("common.save")}
      </button>
    </div>
  );
}

function EditAgentModal({ actor, onClose }: { actor: Actor; onClose: () => void }) {
  const { t } = useI18n();
  const run = useAction();
  const [f, setF] = useState({
    name: actor.name,
    platform: actor.platform,
    role: actor.role,
    emoji: actor.emoji,
    color: actor.color,
    token_budget: actor.token_budget,
    budget_period: actor.budget_period,
    description: actor.description,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Modal
      title={`${t("common.edit")} · @${actor.id}`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn danger"
            style={{ marginInlineEnd: "auto" }}
            onClick={async () => {
              if (!confirm(t("common.confirmDelete"))) return;
              const ok = await run(() => patch(`/api/actors/${actor.id}`, { archived: true }));
              if (ok) {
                invalidate();
                onClose();
                navigate("/agents");
              }
            }}
          >
            {t("agents.archive")}
          </button>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const ok = await run(() => patch(`/api/actors/${actor.id}`, f), t("settings.saved"));
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
          <span>{t("common.name")}</span>
          <input className="input" value={f.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("agents.emoji")}</span>
          <input className="input" value={f.emoji} maxLength={8} onChange={(e) => set("emoji", e.target.value)} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>{t("agents.platform")}</span>
          <select className="select" value={f.platform} onChange={(e) => set("platform", e.target.value)}>
            {PLATFORMS.filter((p) => p !== "human").map((p) => (
              <option key={p} value={p}>
                {PLATFORM_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("agents.role")}</span>
          <select className="select" value={f.role} onChange={(e) => set("role", e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role.${r}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>{t("agents.budget")}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="input" type="number" min={0} step={10000} value={f.token_budget || ""} placeholder={t("agents.unlimited")} onChange={(e) => set("token_budget", Number(e.target.value) || 0)} />
          <select className="select" style={{ width: 110 }} value={f.budget_period} onChange={(e) => set("budget_period", e.target.value as Actor["budget_period"])}>
            {(["day", "week", "month"] as const).map((p) => (
              <option key={p} value={p}>
                {t(`agents.period.${p}`)}
              </option>
            ))}
          </select>
        </div>
      </label>
      <div className="field">
        <span>{t("project.color")}</span>
        <div style={{ display: "flex", gap: 6 }}>
          {PALETTE.map((c) => (
            <button key={c} type="button" aria-label={c} onClick={() => set("color", c)} style={{ width: 20, height: 20, borderRadius: 5, background: c, border: c === f.color ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer" }} />
          ))}
        </div>
      </div>
      <label className="field">
        <span>{t("agents.instructions")}</span>
        <textarea className="textarea" dir="auto" rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} />
        <small>{t("agents.instructionsHint")}</small>
      </label>
    </Modal>
  );
}
