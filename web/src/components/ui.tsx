import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useI18n } from "../i18n";
import { getToken } from "../api";
import { AGENT_STATUS_COLOR, fmtTokens, readableText } from "../format";
import type { Actor, Budget } from "../types";

// ------------------------------------------------------------------ icons
const PATHS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0",
  bot: "M12 3v3M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zm2 5h.01M15 13h.01M9 17h6",
  scale: "M12 3v18M5 7h14M7 7l-3 7a3 3 0 0 0 6 0zM17 7l-3 7a3 3 0 0 0 6 0z",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
  plus: "M12 5v14M5 12h14",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.3-4.3",
  close: "M6 6l12 12M18 6 6 18",
  chevron: "m6 9 6 6 6-6",
  table: "M3 5h18v14H3zM3 10h18M9 10v9",
  kanban: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  send: "M4 12 20 4l-6 16-3-7z",
  handoff: "M4 12h13M13 6l6 6-6 6",
  lock: "M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3",
  flag: "M5 21V4M5 4h12l-2 4 2 4H5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v5l3 2",
  menu: "M4 6h16M4 12h16M4 18h16",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  check: "m5 12 5 5 9-10",
  comment: "M4 5h16v11H8l-4 4z",
  sub: "M6 4v10a2 2 0 0 0 2 2h10M14 12l4 4-4 4",
  key: "M15 7a4 4 0 1 1-3.5 6L5 19.5V17h2.5v-2.5H10l1.5-1.5A4 4 0 0 1 15 7z",
  markdown: "M3 6h18v12H3zM6 15V9l3 3 3-3v6M16 9v6M14 13l2 2 2-2",
  feature: "M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5",
  bug: "M8 9h8v6a4 4 0 0 1-8 0zM9 9V7a3 3 0 0 1 6 0v2M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2",
  flask: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 15h9",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  wrench: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  alert: "M12 3 2 20h20zM12 10v4M12 17h.01",
  loop: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
};

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.more} />
    </svg>
  );
}

// ------------------------------------------------------------------ avatars
export function Avatar({ actor, size = 28, presence = false, title }: { actor: Actor | null | undefined; size?: number; presence?: boolean; title?: string }) {
  if (!actor) {
    return (
      <span className="avatar empty" style={{ ["--size" as string]: `${size}px` }} title={title}>
        <Icon name="user" size={size * 0.55} />
      </span>
    );
  }
  return (
    <span className="avatar" style={{ ["--size" as string]: `${size}px`, background: `color-mix(in srgb, ${actor.color} 30%, var(--surface-2))` }} title={title ?? `${actor.name} (@${actor.id})`}>
      {actor.emoji}
      {presence && <span className="presence" style={{ background: AGENT_STATUS_COLOR[actor.status] ?? AGENT_STATUS_COLOR.offline }} />}
    </span>
  );
}

export function Who({ actor, size = 24, fallback }: { actor: Actor | null | undefined; size?: number; fallback?: string }) {
  return (
    <span className="who">
      <Avatar actor={actor} size={size} />
      <span className="name">{actor ? actor.name : fallback}</span>
    </span>
  );
}

// ------------------------------------------------------------------ pills
export function Pill({ color, children, outline }: { color: string; children: ReactNode; outline?: boolean }) {
  return (
    <span
      className="pill"
      style={
        outline
          ? { color: `color-mix(in srgb, ${color} 50%, var(--text))`, background: `color-mix(in srgb, ${color} 18%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 30%, transparent)` }
          : { background: color, color: readableText(color) }
      }
    >
      {children}
    </span>
  );
}

export function KeyChip({ children }: { children: ReactNode }) {
  return <span className="keychip">{children}</span>;
}

// ------------------------------------------------------------------ popover
export function Popover({ anchor, onClose, children, width }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor.getBoundingClientRect();
    const el = ref.current.getBoundingClientRect();
    const w = Math.max(el.width, width ?? 0);
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + el.height > window.innerHeight - 8) top = Math.max(8, r.top - el.height - 6);
    setPos({ top, left });
  }, [anchor, width]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="popover" role="dialog" style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}>
      {children}
    </div>,
    document.body,
  );
}

/** A button that opens a popover with arbitrary content; the content gets a close() callback. */
export function PopoverButton({
  button,
  children,
  className,
  style,
  width,
  label,
  disabled,
}: {
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  className?: string;
  style?: React.CSSProperties;
  width?: number;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button ref={ref} type="button" className={className} style={style} onClick={() => !disabled && setOpen((o) => !o)} aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled}>
        {button}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={close} width={width}>
          {children(close)}
        </Popover>
      )}
    </>
  );
}

// ------------------------------------------------------------------ modal + drawer
export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".overlay, .popover")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={label}>
        {children}
      </aside>
    </>,
    document.body,
  );
}

// ------------------------------------------------------------------ toasts
interface Toast {
  id: number;
  text: string;
  error?: boolean;
}
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Wrap an async action: shows the error message as a toast. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        toast((e as Error).message, true);
        return undefined;
      }
    },
    [toast],
  );
}

// ------------------------------------------------------------------ markdown
marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? "", { async: false }) as string;
    const withMentions = raw.replace(/(^|[\s>(])@([a-z0-9][a-z0-9_-]{0,39})/gi, '$1<span class="mention">@$2</span>');
    return DOMPurify.sanitize(withMentions, { ADD_ATTR: ["target"] });
  }, [text]);
  return <div className={`md ${className ?? ""}`} dir="auto" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ------------------------------------------------------------------ misc
export function BudgetBar({ budget, compact }: { budget: Budget | undefined; compact?: boolean }) {
  const { t } = useI18n();
  if (!budget) return null;
  if (!budget.budget) {
    return compact ? null : (
      <div className="budget-label">
        <span>{t("agents.unlimited")}</span>
        <span>
          {fmtTokens(budget.used)} / {t(`agents.period.${budget.period}`)}
        </span>
      </div>
    );
  }
  const ratio = budget.ratio ?? 0;
  const cls = ratio >= 1 ? "over" : ratio > 0.8 ? "warn" : "";
  return (
    <div>
      <div className={`budget-bar ${cls}`} title={t("agents.used", { used: fmtTokens(budget.used), budget: fmtTokens(budget.budget) })}>
        <i style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
      </div>
      {!compact && (
        <div className="budget-label">
          <span>{t("agents.used", { used: fmtTokens(budget.used), budget: fmtTokens(budget.budget) })}</span>
          <span>{t("agents.left", { n: fmtTokens(Math.max(budget.remaining ?? 0, 0)) })}</span>
        </div>
      )}
    </div>
  );
}

export function CopyButton({ text, small, label }: { text: string; small?: boolean; label?: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${small ? "small" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
      {done ? t("common.copied") : (label ?? t("common.copy"))}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function AgentViewLink({ href }: { href: string }) {
  const { t } = useI18n();
  const token = getToken();
  const url = token ? `${href}${href.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : href;
  return (
    <a className="btn small ghost" href={url} target="_blank" rel="noreferrer" title={t("common.agentViewHint")}>
      <Icon name="markdown" size={15} />
      {t("common.agentView")}
    </a>
  );
}
