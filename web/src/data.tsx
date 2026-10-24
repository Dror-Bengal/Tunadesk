import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useApi } from "./api";
import type { Actor, Me, Project } from "./types";

interface Desk {
  me: Me | undefined;
  actors: Actor[];
  agents: Actor[];
  projects: Project[];
  actor: (id: string | null | undefined) => Actor | undefined;
  project: (idOrKey: string | null | undefined) => Project | undefined;
  ready: boolean;
}

const Ctx = createContext<Desk | null>(null);

/** Small, frequently-needed lookups shared by every page (refreshed live via SSE). */
export function DeskProvider({ children }: { children: ReactNode }) {
  const me = useApi<Me>("/api/me");
  const actors = useApi<Actor[]>("/api/actors");
  const projects = useApi<Project[]>("/api/projects");
  const value = useMemo<Desk>(() => {
    const list = actors.data ?? [];
    const plist = projects.data ?? [];
    const byId = new Map(list.map((a) => [a.id, a]));
    return {
      me: me.data,
      actors: list,
      agents: list.filter((a) => a.kind === "agent"),
      projects: plist,
      actor: (id) => (id ? byId.get(id) : undefined),
      project: (ref) => (ref ? plist.find((p) => p.id === ref || p.key.toLowerCase() === ref.toLowerCase()) : undefined),
      ready: Boolean(me.data && actors.data && projects.data),
    };
  }, [me.data, actors.data, projects.data]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDesk(): Desk {
  const v = useContext(Ctx);
  if (!v) throw new Error("useDesk outside provider");
  return v;
}
