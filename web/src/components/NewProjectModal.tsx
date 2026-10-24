import { useState } from "react";
import { post, invalidate } from "../api";
import { useI18n } from "../i18n";
import { navigate } from "../router";
import { PALETTE } from "../format";
import { PRIORITIES, type Priority, type Project } from "../types";
import { Modal, useAction } from "./ui";

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const run = useAction();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [color, setColor] = useState(PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const p = await run(
      () => post<Project>("/api/projects", { name: name.trim(), key: key.trim() || undefined, description, repo_path: repoPath.trim(), repo_url: repoUrl.trim(), priority, color }),
      t("project.created"),
    );
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
          <button className="btn primary" onClick={submit} disabled={!name.trim() || busy}>
            {t("common.create")}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field-row">
          <label className="field">
            <span>{t("common.name")}</span>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>
              {t("project.key")} <small>({t("common.optional")})</small>
            </span>
            <input className="input" value={key} maxLength={8} placeholder="WEB" onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
          </label>
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
