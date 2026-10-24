import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Activity } from "./types";

const TOKEN_KEY = "tunadesk.adminToken";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let unauthorizedHandler: (() => void) | null = null;
export const onUnauthorized = (fn: () => void) => (unauthorizedHandler = fn);

export async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method: init.method ?? "GET", headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
  if (res.status === 401) unauthorizedHandler?.();
  const type = res.headers.get("content-type") ?? "";
  const payload = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (payload as { error?: { message?: string } })?.error?.message ?? String(payload));
  return payload as T;
}

export const post = <T>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });
export const patch = <T>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

// ---------------------------------------------------------------------------
// Live data: every server event bumps a global version; mounted queries refetch.
// ---------------------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();
const activityListeners = new Set<(a: Activity) => void>();
let bumpTimer: ReturnType<typeof setTimeout> | null = null;

export function invalidate() {
  if (bumpTimer) return;
  bumpTimer = setTimeout(() => {
    bumpTimer = null;
    version++;
    listeners.forEach((l) => l());
  }, 120);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function onActivity(fn: (a: Activity) => void) {
  activityListeners.add(fn);
  return () => {
    activityListeners.delete(fn);
  };
}

let source: EventSource | null = null;
export function connectEvents(onStatus: (live: boolean) => void) {
  source?.close();
  const token = getToken();
  source = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  source.addEventListener("hello", () => onStatus(true));
  source.addEventListener("activity", (e) => {
    try {
      const a = JSON.parse((e as MessageEvent).data) as Activity;
      activityListeners.forEach((l) => l(a));
    } catch {
      /* ignore malformed */
    }
    invalidate();
  });
  source.onerror = () => onStatus(false);
  return () => source?.close();
}

const cache = new Map<string, unknown>();

export function useApi<T>(path: string | null): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const v = useSyncExternalStore(subscribe, () => version);
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T | undefined) : undefined));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path && !cache.has(path)));
  const [nonce, setNonce] = useState(0);
  const current = useRef(path);
  current.current = path;

  useEffect(() => {
    if (!path) return;
    setData(cache.get(path) as T | undefined);
    if (!cache.has(path)) setLoading(true);
    let cancelled = false;
    api<T>(path)
      .then((d) => {
        if (cancelled || current.current !== path) return;
        cache.set(path, d);
        setData(d);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, v, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data: path ? data : undefined, error, loading, reload };
}
