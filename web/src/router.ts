import { useSyncExternalStore } from "react";

// Hash routing keeps the server dumb (any path serves index.html) and deep links shareable.
// Shape: #/p/WEB/kanban?task=WEB-12

export interface Route {
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs ?? "") };
}

let current = parse();
const listeners = new Set<() => void>();
window.addEventListener("hashchange", () => {
  current = parse();
  listeners.forEach((l) => l());
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function href(path: string, query?: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ""}`;
}

export function navigate(path: string, query?: Record<string, string | null | undefined>) {
  window.location.hash = href(path, query).slice(1);
}

function currentPath() {
  return "/" + current.parts.map(encodeURIComponent).join("/");
}

export function openTask(key: string) {
  const q = Object.fromEntries(current.query.entries());
  navigate(currentPath(), { ...q, task: key });
}

export function closeTask() {
  const q = Object.fromEntries(current.query.entries());
  delete q.task;
  navigate(currentPath(), q);
}

export function setQuery(key: string, value: string | null) {
  const q = Object.fromEntries(current.query.entries());
  if (value) q[key] = value;
  else delete q[key];
  navigate(currentPath(), q);
}
