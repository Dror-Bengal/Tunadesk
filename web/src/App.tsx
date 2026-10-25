import { useEffect, useState } from "react";
import { api, connectEvents, onUnauthorized, setToken, invalidate } from "./api";
import { useI18n } from "./i18n";
import { DeskProvider, useDesk } from "./data";
import { href, useRoute, navigate } from "./router";
import { Icon } from "./components/ui";
import { NewProjectModal } from "./components/NewProjectModal";
import { TaskDrawer } from "./pages/TaskDrawer";
import { Home } from "./pages/Home";
import { ProjectPage } from "./pages/Project";
import { InboxPage, MyWorkPage } from "./pages/Inbox";
import { AgentsPage } from "./pages/Agents";
import { DecisionsPage } from "./pages/Decisions";
import { SettingsPage } from "./pages/Settings";
import type { Me } from "./types";

export function App() {
  const [auth, setAuth] = useState<"checking" | "ok" | "needed">("checking");

  useEffect(() => {
    onUnauthorized(() => setAuth("needed"));
    api<Me>("/api/me")
      .then(() => setAuth("ok"))
      .catch(() => setAuth((a) => (a === "checking" ? "needed" : a)));
  }, []);

  if (auth === "checking") return null;
  if (auth === "needed") return <Login onDone={() => setAuth("ok")} />;
  return (
    <DeskProvider>
      <Shell />
    </DeskProvider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  return (
    <div className="login">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setToken(value.trim());
          try {
            await api("/api/me");
            onDone();
          } catch {
            setError(true);
          }
        }}
      >
        <div className="brand" style={{ padding: "0 0 12px" }}>
          <img src="/favicon.svg" alt="" /> Tunadesk
        </div>
        <h2 style={{ margin: "0 0 6px" }}>{t("login.title")}</h2>
        <p style={{ color: "var(--text-2)", marginTop: 0 }}>{t("login.body")}</p>
        <input className="input" type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={error} />
        <button className="btn primary" style={{ marginTop: 12, width: "100%" }}>
          {t("login.submit")}
        </button>
      </form>
    </div>
  );
}

function Shell() {
  const { t, lang, setLang } = useI18n();
  const desk = useDesk();
  const route = useRoute();
  const [live, setLive] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [newProject, setNewProject] = useState(false);

  // ?snapshot renders a static page (no live connection) — for screenshots, printing and embedding.
  useEffect(() => (new URLSearchParams(window.location.search).has("snapshot") ? undefined : connectEvents(setLive)), []);
  useEffect(() => {
    // Refresh when the tab comes back, in case events were missed while asleep.
    const onVis = () => document.visibilityState === "visible" && invalidate();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => setNavOpen(false), [route]);

  const [section, ...rest] = route.parts;
  const unread = desk.me?.unread ?? 0;
  const taskKey = route.query.get("task");

  let page;
  switch (section) {
    case undefined:
      page = <Home onNewProject={() => setNewProject(true)} />;
      break;
    case "p":
      page = <ProjectPage projectKey={rest[0]} view={rest[1] ?? "table"} />;
      break;
    case "inbox":
      page = <InboxPage />;
      break;
    case "my":
      page = <MyWorkPage />;
      break;
    case "agents":
      page = <AgentsPage agentId={rest[0]} />;
      break;
    case "decisions":
      page = <DecisionsPage />;
      break;
    case "settings":
      page = <SettingsPage />;
      break;
    default:
      page = <Home onNewProject={() => setNewProject(true)} />;
  }

  const navLink = (path: string, icon: string, label: string, active: boolean, extra?: React.ReactNode) => (
    <a href={href(path)} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
      <Icon name={icon} size={17} />
      <span>{label}</span>
      {extra}
    </a>
  );

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar" aria-label="Navigation">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <div>
            Tunadesk
            <small>{desk.me?.version ? `v${desk.me.version}` : ""}</small>
          </div>
        </div>
        <nav className="nav">
          {navLink("/", "home", t("nav.home"), !section)}
          {navLink("/inbox", "inbox", t("nav.inbox"), section === "inbox", unread > 0 ? <span className="count">{unread}</span> : null)}
          {navLink("/my", "user", t("nav.mywork"), section === "my")}
          {navLink("/agents", "bot", t("nav.agents"), section === "agents")}
          {navLink("/decisions", "scale", t("nav.decisions"), section === "decisions")}
        </nav>
        <div className="nav-section">
          <span>{t("nav.projects")}</span>
          <button className="icon-btn" onClick={() => setNewProject(true)} aria-label={t("nav.newProject")} title={t("nav.newProject")}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        <nav className="nav projects-nav">
          {[...desk.clients.map((c) => ({ id: c.id, name: c.name })), { id: null as string | null, name: desk.clients.length ? t("client.none") : "" }].map((group) => {
            const list = desk.projects.filter((p) => (p.client_id ?? null) === group.id);
            if (!list.length) return null;
            return (
              <div key={group.id ?? "none"} className="client-group">
                {group.name && <div className="client-label">{group.name}</div>}
                {list.map((p) => (
                  <a key={p.id} href={href(`/p/${p.key}`)} className={section === "p" && rest[0]?.toUpperCase() === p.key ? "active" : ""} style={{ opacity: p.status === "active" ? 1 : 0.6 }}>
                    <span className="project-dot" style={{ background: p.color }} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    <span className="key">{p.key}</span>
                  </a>
                ))}
              </div>
            );
          })}
        </nav>
        <nav className="nav" style={{ paddingBottom: 8 }}>
          {navLink("/settings", "gear", t("nav.settings"), section === "settings")}
          <a href="/llms.txt" target="_blank" rel="noreferrer">
            <Icon name="bot" size={17} />
            <span>{t("nav.forAgents")}</span>
            <span className="key">llms.txt</span>
          </a>
        </nav>
        <div className="sidebar-footer">
          <span className={`live-dot${live ? " on" : ""}`} />
          <span>{live ? t("nav.live") : t("nav.offline")}</span>
          <span style={{ flex: 1 }} />
          <button className="btn small ghost" onClick={() => setLang(lang === "he" ? "en" : "he")} aria-label="Switch language">
            <Icon name="globe" size={14} />
            {lang === "he" ? "English" : "עברית"}
          </button>
        </div>
      </aside>

      <main className="main" id="main">
        <div className="mobile-bar">
          <button className="icon-btn" onClick={() => setNavOpen(true)} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <img src="/favicon.svg" alt="" width={24} /> Tunadesk
          <span style={{ flex: 1 }} />
          <button className="icon-btn" onClick={() => navigate("/inbox")} aria-label={t("nav.inbox")}>
            <Icon name="inbox" />
          </button>
        </div>
        {navOpen && <div className="drawer-overlay" style={{ zIndex: 44 }} onClick={() => setNavOpen(false)} />}
        {page}
      </main>

      {taskKey && <TaskDrawer taskKey={taskKey} />}
      {newProject && <NewProjectModal onClose={() => setNewProject(false)} />}
    </div>
  );
}
