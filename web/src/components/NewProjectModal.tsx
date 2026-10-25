import { useState } from "react";
import { ApiError, post, invalidate } from "../api";
import { useI18n } from "../i18n";
import { navigate } from "../router";
import { PALETTE } from "../format";
import { PRIORITIES, type Priority, type Project } from "../types";
import { Modal, useAction, useToast } from "./ui";
import { useDesk } from "../data";
import { ClientSelect } from "../pages/Project";

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const run = useAction();
  const toast = useToast();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const { clients } = useDesk();
  const [client, setClient] = useState("");
  const [color, setColor] = useState(PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [busy, setBusy] = useState(false);

  const [similar, setSimilar] = useState<Array<{ key: string; name: string; matched: string }>>([]);
  const submit = async (force = false) => {
    if (!name.trim()) return;
    setBusy(true);
    let p: (Project & { existing?: boolean }) | undefined;
    try {
      p = await post<Project & { existing?: boolean }>("/api/projects", { name: name.trim(), key: key.trim() || undefined, description, repo_path: repoPath.trim(), repo_url: repoUrl.trim(), priority, color, force, client: client || undefined });
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === "possible_duplicate_project") {
        setSimilar((e.details?.similar as typeof similar) ?? []);
        return;
      }
      await run(() => Promise.reject(e));
      return;
    }
    if (p) toast(p.existing ? t("project.existing", { key: p.key }) : t("project.created"));
    setBusy(false);
    if (p) {
      invalidate();
      onClose();
      navigate(`/p/${p.key}`);
    }
  };

  return (
    <Modal
      title={t("nav.newProject")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={() => submit(similar.length > 0)} disabled={!name.trim() || busy}>
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
            <strong>{t("project.similarTitle")}</strong>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              {similar.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className="btn small ghost"
                  style={{ justifyContent: "flex-start" }}
                  onClick={() => {
                    onClose();
                    navigate(`/p/${m.key}`);
                  }}
                >
                  {m.key} · {m.name}
                  {m.matched !== m.name ? ` (${m.matched})` : ""}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="field-row">
          <label className="field">
            <span>{t("common.name")}</span>
            <input
              className="input"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSimilar([]);
              }}
            />
          </label>
          <label className="field">
            <span>
              {t("project.key")} <small>({t("common.optional")})</small>
            </span>
            <input className="input" value={key} maxLength={8} placeholder="WEB" onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
          </label>
        </div>
        <div className="field">
          <span>{t("client.label")}</span>
          <ClientSelect value={client} clients={clients} onChange={setClient} />
        </div>
        <label className="field">
          <span>{t("common.description")}</span>
          <textarea className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("project.repoPath")}</span>
          <input className="input" dir="ltr" value={repoPath} placeholder="/Users/you/code/app" onChange={(e) => setRepoPath(e.target.value)} />
          <small>{t("project.repoPathHint")}</small>
        </label>
        <label className="field">
          <span>{t("project.repoUrl")}</span>
          <input className="input" dir="ltr" value={repoUrl} placeholder="https://github.com/you/app" onChange={(e) => setRepoUrl(e.target.value)} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>{t("project.priority")}</span>
            <select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>{t("project.color")}</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => setColor(c)}
                  style={{ width: 22, height: 22, borderRadius: 6, background: c, border: c === color ? "2px solid var(--text)" : "2px solid transparent", cursor: "pointer" }}
                />
              ))}
            </div>
          </div>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
