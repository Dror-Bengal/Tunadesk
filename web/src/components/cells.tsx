import { useMemo, useState } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { useDesk } from "../data";
import { PRIORITY_COLOR, STATUS_COLOR, dueState, fmtDate, fmtTokens, fromDateInput, readableText, toDateInput } from "../format";
import { PRIORITIES, TASK_STATUSES, TASK_TYPES, type Priority, type TaskStatus, type TaskType } from "../types";
import { Avatar, Icon, PopoverButton } from "./ui";

/** Monday-style full-bleed coloured cell with a grid of choices. */
function ColorChoiceCell<T extends string>({
  value,
  options,
  colors,
  labelKey,
  onChange,
  name,
}: {
  value: T;
  options: readonly T[];
  colors: Record<T, string>;
  labelKey: (v: T) => MessageKey;
  onChange: (v: T) => void;
  name: string;
}) {
  const { t } = useI18n();
  const bg = colors[value];
  return (
    <PopoverButton
      className="cell-fill"
      style={{ background: bg, color: readableText(bg) }}
      label={`${name}: ${t(labelKey(value))}`}
      width={190}
      button={
        <>
          {t(labelKey(value))}
          <span className="fold" />
        </>
      }
    >
      {(close) => (
        <div className="choice-grid">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              className={`choice${o === value ? " selected" : ""}`}
              style={{ background: colors[o], color: readableText(colors[o]) }}
              onClick={() => {
                close();
                if (o !== value) onChange(o);
              }}
            >
              {t(labelKey(o))}
            </button>
          ))}
        </div>
      )}
    </PopoverButton>
  );
}

export function StatusCell({ value, onChange }: { value: TaskStatus; onChange: (v: TaskStatus) => void }) {
  return <ColorChoiceCell name="Status" value={value} options={TASK_STATUSES} colors={STATUS_COLOR} labelKey={(v) => `status.${v}` as MessageKey} onChange={onChange} />;
}

export function PriorityCell({ value, onChange }: { value: Priority; onChange: (v: Priority) => void }) {
  return <ColorChoiceCell name="Priority" value={value} options={PRIORITIES} colors={PRIORITY_COLOR} labelKey={(v) => `priority.${v}` as MessageKey} onChange={onChange} />;
}

const TYPE_ICON: Record<TaskType, string> = { feature: "feature", bug: "bug", test: "flask", review: "eye", chore: "wrench", research: "search", docs: "doc" };
export const typeIcon = (t: TaskType) => <Icon name={TYPE_ICON[t] ?? "more"} size={14} className="type-icon" />;

export function TypeCell({ value, onChange }: { value: TaskType; onChange: (v: TaskType) => void }) {
  const { t } = useI18n();
  return (
    <PopoverButton className="cell-btn" label={`Type: ${t(`type.${value}` as MessageKey)}`} button={<span className="type-label">{typeIcon(value)} {t(`type.${value}` as MessageKey)}</span>} width={170}>
      {(close) => (
        <div className="menu">
          {TASK_TYPES.map((o) => (
            <button
              key={o}
              type="button"
              className={o === value ? "hl" : ""}
              onClick={() => {
                close();
                if (o !== value) onChange(o);
              }}
            >
              {typeIcon(o)} {t(`type.${o}` as MessageKey)}
            </button>
          ))}
        </div>
      )}
    </PopoverButton>
  );
}

export function PersonPicker({ value, onPick, close, allowNone = true }: { value: string | null; onPick: (id: string | null) => void; close: () => void; allowNone?: boolean }) {
  const { t } = useI18n();
  const { actors } = useDesk();
  const [q, setQ] = useState("");
  const list = useMemo(
    () => actors.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || a.id.includes(q.toLowerCase())),
    [actors, q],
  );
  return (
    <div className="menu" style={{ minWidth: 230 }}>
      <input className="input" autoFocus placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
      {list.map((a) => (
        <button
          key={a.id}
          type="button"
          className={a.id === value ? "hl" : ""}
          onClick={() => {
            close();
            onPick(a.id);
          }}
        >
          <Avatar actor={a} size={24} presence={a.kind === "agent"} />
          <span style={{ flex: 1 }}>
            {a.name}
            <span style={{ color: "var(--text-3)", fontSize: 12 }}> @{a.id}</span>
          </span>
        </button>
      ))}
      {allowNone && value && (
        <>
          <div className="sep" />
          <button
            type="button"
            onClick={() => {
              close();
              onPick(null);
            }}
          >
            <Avatar actor={null} size={24} /> {t("common.nobody")}
          </button>
        </>
      )}
    </div>
  );
}

export function PersonCell({ value, onChange, showName }: { value: string | null; onChange: (id: string | null) => void; showName?: boolean }) {
  const { t } = useI18n();
  const { actor } = useDesk();
  const a = actor(value);
  return (
    <PopoverButton
      className="cell-btn"
      label={`${t("col.owner")}: ${a?.name ?? t("common.nobody")}`}
      button={
        <>
          <Avatar actor={a} size={26} presence={a?.kind === "agent"} />
          {showName && <span>{a?.name ?? t("common.nobody")}</span>}
        </>
      }
    >
      {(close) => <PersonPicker value={value} onPick={onChange} close={close} />}
    </PopoverButton>
  );
}

export function DateCell({ value, status, onChange }: { value: string | null; status: TaskStatus; onChange: (v: string | null) => void }) {
  const { t, locale } = useI18n();
  const state = dueState(value, status);
  return (
    <PopoverButton
      className="cell-btn"
      label={`${t("col.due")}: ${value ? fmtDate(value, locale) : "—"}`}
      button={value ? <span className={`due ${state ?? ""}`}>{fmtDate(value, locale)}</span> : <Icon name="clock" size={15} className="lease" />}
    >
      {(close) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            type="date"
            className="input"
            autoFocus
            defaultValue={toDateInput(value)}
            onChange={(e) => {
              onChange(fromDateInput(e.target.value));
              close();
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            {[0, 1, 7].map((d) => (
              <button
                key={d}
                type="button"
                className="btn small"
                onClick={() => {
                  const dt = new Date();
                  dt.setDate(dt.getDate() + d);
                  onChange(fromDateInput(dt.toISOString().slice(0, 10)));
                  close();
                }}
              >
                {d === 0 ? t("common.today") : d === 1 ? t("common.tomorrow") : "+7"}
              </button>
            ))}
            {value && (
              <button
                type="button"
                className="btn small ghost"
                onClick={() => {
                  onChange(null);
                  close();
                }}
              >
                {t("common.clear")}
              </button>
            )}
          </div>
        </div>
      )}
    </PopoverButton>
  );
}

export function TokensCell({ used, estimate, onChange }: { used: number; estimate: number; onChange: (estimate: number) => void }) {
  const { t } = useI18n();
  const ratio = estimate ? used / estimate : 0;
  return (
    <PopoverButton
      className="cell-btn"
      label={`${t("col.tokens")}: ${fmtTokens(used)} / ${fmtTokens(estimate)}`}
      button={
        <span className="tokens-cell">
          <span>
            {fmtTokens(used)}
            {estimate ? ` / ${fmtTokens(estimate)}` : ""}
          </span>
          {estimate > 0 && (
            <span className={`budget-bar ${ratio > 1 ? "over" : ratio > 0.8 ? "warn" : ""}`}>
              <i style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
            </span>
          )}
        </span>
      }
    >
      {(close) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = Number(new FormData(e.currentTarget).get("est"));
            if (Number.isFinite(v)) onChange(Math.max(0, Math.round(v)));
            close();
          }}
        >
          <label className="field" style={{ margin: 0 }}>
            <span>{t("task.estimate")}</span>
            <input name="est" type="number" min={0} step={1000} className="input" defaultValue={estimate || ""} autoFocus />
          </label>
        </form>
      )}
    </PopoverButton>
  );
}
