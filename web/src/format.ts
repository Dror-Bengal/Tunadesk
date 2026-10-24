import type { Priority, TaskStatus } from "./types";

export const STATUS_COLOR: Record<TaskStatus, string> = {
  backlog: "#c4c4c4",
  todo: "#579bfc",
  in_progress: "#fdab3d",
  review: "#a25ddc",
  testing: "#784bd1",
  blocked: "#e2445c",
  done: "#00c875",
  canceled: "#676879",
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  critical: "#333333",
  high: "#401694",
  medium: "#5559df",
  low: "#579bfc",
};

export const PROJECT_STATUS_COLOR: Record<string, string> = {
  active: "#00c875",
  paused: "#fdab3d",
  done: "#579bfc",
  archived: "#c4c4c4",
};

export const DECISION_STATUS_COLOR: Record<string, string> = {
  proposed: "#fdab3d",
  accepted: "#00c875",
  rejected: "#e2445c",
  superseded: "#c4c4c4",
};

export const AGENT_STATUS_COLOR: Record<string, string> = {
  working: "#00c875",
  idle: "#579bfc",
  offline: "#c4c4c4",
  blocked: "#e2445c",
};

export const RUN_STATUS_COLOR: Record<string, string> = {
  queued: "#c4c4c4",
  running: "#fdab3d",
  succeeded: "#00c875",
  failed: "#e2445c",
  skipped: "#a0a0a0",
};

export const PALETTE = ["#579bfc", "#00c875", "#a25ddc", "#fdab3d", "#e2445c", "#0086c0", "#ff642e", "#037f4c", "#bb3354", "#784bd1", "#ff7575", "#66ccff"];

export const PLATFORM_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  grok: "Grok",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
  gemini: "Gemini",
  human: "Human",
  other: "Other",
};

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${(n / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function relTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return "—";
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const abs = Math.abs(diff);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export function fmtDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function dueState(iso: string | null, status: TaskStatus): "overdue" | "soon" | "ok" | null {
  if (!iso) return null;
  if (status === "done" || status === "canceled") return "ok";
  const hours = (Date.parse(iso) - Date.now()) / 3_600_000;
  if (hours < 0) return "overdue";
  if (hours < 48) return "soon";
  return "ok";
}

/** yyyy-mm-dd for <input type=date>. */
export function toDateInput(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export function fromDateInput(v: string): string | null {
  if (!v) return null;
  return new Date(`${v}T17:00:00`).toISOString();
}

export function readableText(bg: string): string {
  const hex = bg.replace("#", "");
  if (hex.length !== 6) return "#fff";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 170 ? "#1f1f1f" : "#ffffff";
}
