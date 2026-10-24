import { useEffect, useState } from "react";
import { getToken, invalidate, patch, setToken, useApi } from "../api";
import { useI18n } from "../i18n";
import { useDesk } from "../data";
import { CopyButton, useAction } from "../components/ui";

type Theme = "system" | "light" | "dark";

function readTheme(): Theme {
  try {
    const v = localStorage.getItem("tunadesk.theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const run = useAction();
  const { me } = useDesk();
  const settings = useApi<{ loop_guard_limit: number; default_lease_minutes: number }>("/api/settings");
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [guard, setGuard] = useState(6);
  const [lease, setLease] = useState(60);
  const mcpUrl = `${window.location.origin}/mcp`;

  useEffect(() => {
    if (me) {
      setName(me.actor.name);
      setEmoji(me.actor.emoji);
    }
  }, [me]);
  useEffect(() => {
    if (settings.data) {
      setGuard(settings.data.loop_guard_limit);
      setLease(settings.data.default_lease_minutes);
    }
  }, [settings.data]);

  const applyTheme = (v: Theme) => {
    setTheme(v);
    try {
      if (v === "system") localStorage.removeItem("tunadesk.theme");
      else localStorage.setItem("tunadesk.theme", v);
    } catch {
      /* ignore */
    }
    if (v === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
  };

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-header">
        <h1>{t("settings.title")}</h1>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>{t("settings.you")}</h2>
        </div>
        <div className="card-body">
          <div className="field-row">
            <label className="field">
              <span>{t("settings.displayName")}</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>{t("agents.emoji")}</span>
              <input className="input" value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>{t("settings.language")}</span>
              <select className="select" value={lang} onChange={(e) => setLang(e.target.value as "en" | "he")}>
                <option value="en">English</option>
                <option value="he">עברית</option>
              </select>
            </label>
            <label className="field">
              <span>{t("settings.theme")}</span>
              <select className="select" value={theme} onChange={(e) => applyTheme(e.target.value as Theme)}>
                <option value="system">{t("settings.theme.system")}</option>
                <option value="light">{t("settings.theme.light")}</option>
                <option value="dark">{t("settings.theme.dark")}</option>
              </select>
            </label>
          </div>
          <button
            className="btn primary"
            onClick={async () => {
              if (!me) return;
              await run(() => patch(`/api/actors/${me.actor.id}`, { name, emoji }), t("settings.saved"));
              invalidate();
            }}
          >
            {t("common.save")}
          </button>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>{t("settings.guardrails")}</h2>
        </div>
        <div className="card-body">
          <label className="field">
            <span>{t("settings.loopGuard")}</span>
            <input className="input" type="number" min={1} max={100} style={{ maxWidth: 140 }} value={guard} onChange={(e) => setGuard(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>{t("settings.lease")}</span>
            <input className="input" type="number" min={1} max={1440} style={{ maxWidth: 140 }} value={lease} onChange={(e) => setLease(Number(e.target.value))} />
          </label>
          <button className="btn primary" onClick={() => run(() => patch("/api/settings", { loop_guard_limit: guard, default_lease_minutes: lease }), t("settings.saved"))}>
            {t("common.save")}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>{t("settings.connection")}</h2>
        </div>
        <div className="card-body">
          <div className="field">
            <span>{t("settings.mcpUrl")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" readOnly dir="ltr" value={mcpUrl} />
              <CopyButton text={mcpUrl} />
            </div>
          </div>
          <div className="field">
            <span>{t("settings.llms")}</span>
            <a href="/llms.txt" target="_blank" rel="noreferrer" dir="ltr">
              {window.location.origin}/llms.txt
            </a>
          </div>
          {getToken() && (
            <button
              className="btn danger"
              onClick={() => {
                setToken(null);
                window.location.reload();
              }}
            >
              {t("settings.signOut")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
