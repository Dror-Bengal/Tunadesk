import type { Priority, TaskStatus } from "./types";

export const STATUS_COLOR: Record<TaskStatus, string> = {
  backlog: "#5f5a52",
  todo: "#44546a",
  in_progress: "#a8661c",
  review: "#6b4a8a",
  testing: "#4e4a8c",
  blocked: "#9e2f3a",
  done: "#2f6b4f",
  canceled: "#3f3d3a",
};

export const PRIORITY_COLOR: Record<Priority, string> = {
  critical: "#7a1f2b",
  high: "#8a5a1c",
  medium: "#3d5a52",
  low: "#5f5a52",
};

export const PROJECT_STATUS_COLOR: Record<string, string> = {
  active: "#2f6b4f",
  paused: "#a8661c",
  done: "#44546a",
  archived: "#5f5a52",
};

export const DECISION_STATUS_COLOR: Record<string, string> = {
  proposed: "#a8661c",
  accepted: "#2f6b4f",
  rejected: "#9e2f3a",
  superseded: "#5f5a52",
};

export const AGENT_STATUS_COLOR: Record<string, string> = {
  working: "#3f8a63",
  idle: "#6b7a8f",
  offline: "#5f5a52",
  blocked: "#9e2f3a",
};

export const RUN_STATUS_COLOR: Record<string, string> = {
  queued: "#5f5a52",
  running: "#a8661c",
  succeeded: "#2f6b4f",
  failed: "#9e2f3a",
  skipped: "#57534c",
};

export const PALETTE = ["#2f6b4f", "#8a5a1c", "#6b4a8a", "#9e2f3a", "#44546a", "#a8661c", "#2d6a6a", "#7a3b5c", "#5c6b2f", "#4e4a8c", "#8c4a2f", "#57534c"];

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
  return (r * 299 + g * 587 + b * 114) / 1000 > 170 ? "#1d1b18" : "#f6f1e7";
}
