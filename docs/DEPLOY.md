# Running Tunadesk beyond localhost

Local-first is the default: agents on your machine reach `http://127.0.0.1:4545`. Cloud agents
(Codex cloud, hosted bots, webhooks from n8n) need a URL they can reach.

## Option A — tunnel your local desk

```bash
TUNADESK_ADMIN_TOKEN=$(openssl rand -hex 24) \
TUNADESK_PUBLIC_URL=https://desk.example.com \
npm start -- --host 127.0.0.1
cloudflared tunnel --url http://127.0.0.1:4545    # or ngrok, tailscale funnel
```

Set `TUNADESK_PUBLIC_URL` to the tunnel URL so setup snippets and wake-up prompts point there.
Keep the admin token: the web UI asks for it.

## Option B — Docker

```bash
docker build -t tunadesk .
docker run -d --name tunadesk -p 4545:4545 \
  -e TUNADESK_ADMIN_TOKEN=change-me \
  -e TUNADESK_PUBLIC_URL=https://desk.example.com \
  -v tunadesk-data:/data tunadesk
```

or `docker compose up -d` with the included `docker-compose.yml`.

The container binds `0.0.0.0`, so the admin token is mandatory (the server refuses to start without it).
Put it behind HTTPS (Caddy, Cloudflare, Fly.io, Railway, Render…).

A cloud desk can still wake CLI agents only on the machine where it runs; use **webhook** triggers to
reach agents elsewhere (a remote runner is on the roadmap).

## Backups

Everything is in one SQLite file (`~/.tunadesk/tunadesk.db` or `/data/tunadesk.db`). Back it up with
`sqlite3 tunadesk.db ".backup backup.db"` while running, or copy it while stopped.
