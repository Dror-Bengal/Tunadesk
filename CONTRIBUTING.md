# Contributing

Thanks for helping! Tunadesk is small on purpose — please keep it that way.

```bash
npm install
npm run dev        # API :4545 (tsx watch) + UI :5173 (vite)
npm test           # server tests (vitest)
npm run typecheck
```

- Business rules belong in `server/src/service.ts`, with a test in `server/test/`.
- New agent-facing behaviour needs an MCP tool, a REST route and a line in `docs/AGENT_PROTOCOL.md`.
- UI strings go through `web/src/i18n.tsx` in **both** English and Hebrew; use logical CSS properties
  (`margin-inline-start`, not `margin-left`) so RTL keeps working.
- Keep dependencies few. The server has four.

Using Tunadesk to build Tunadesk is encouraged: agents' PRs should reference their task key.
