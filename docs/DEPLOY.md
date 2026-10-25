# Running Tunadesk beyond localhost

Local-first is the default: agents on your machine reach `http://127.0.0.1:4545`. Cloud agents
(Codex cloud, hosted bots, webhooks from n8n) need a URL they can reach.

## Option 0 — one always-on Mac with OrbStack (or Docker Desktop)

The desk runs in a container on one Mac; agents on any machine in the same network connect to it.

```bash
cp .env.example .env
#   TUNADESK_ADMIN_TOKEN=$(openssl rand -hex 24)
#   TUNADESK_PUBLIC_URL=http://<mac-lan-ip>:4545     # `ipconfig getifaddr en0`
#   TUNADESK_DATA=/Users/<you>/.tunadesk             # keep the SQLite file on the host
docker compose up -d --build
```

- Open `http://<mac-lan-ip>:4545` and paste the admin token.
- Use the IP rather than `<name>.local`: not every client resolves mDNS names. Reserve the IP in your
  router (DHCP reservation) so it never changes.
- macOS may ask once whether to accept incoming connections — allow it.
- For machines outside your network, use Tailscale (set `TUNADESK_PUBLIC_URL` to the tailnet name) or a
  tunnel (below).
- Update: `git pull && docker compose up -d --build`. Logs: `docker logs -f tunadesk`.
- The runner inside the container can send **webhooks**, but CLI agents live on your computers — install
  `tunadesk runner` there (next section).

## Waking agents on other computers: `tunadesk runner`

Each computer that hosts agents runs a small runner. It connects to the desk with the agent's own token,
waits for wake-ups and launches Claude Code / Codex / Grok CLI locally, in that machine's checkout of
the project, then reports the result back.

```bash
git clone https://github.com/Dror-Bengal/Tunadesk.git ~/tunadesk && cd ~/tunadesk && npm install && npm run build
node server/dist/cli/index.js runner \
  --url http://<desk-ip>:4545 \
  --token <claude-dev token> --token <codex-qa token> \
  --repo WEB=~/code/marketing-site --repo API=~/code/billing \
  --save                                  # → ~/.tunadesk/runner.json (mode 600)
node server/dist/cli/index.js runner install   # macOS: background service, starts at login
```

- On the agent's **Trigger** tab choose *Run on → the agent's own computer*. While that computer is
  offline, wake-ups wait and are delivered when its runner reconnects (up to 24 hours).
- *Auto* uses the runner when it is online and the desk's machine otherwise.
- The agent page shows which runner is connected; failed runs notify you with the reason (e.g. a missing
  `--repo` mapping).
- Logs: `~/.tunadesk/runner.log`. Remove the service with `runner uninstall`.

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
