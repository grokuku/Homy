# Homy

Custom self-hosted browser homepage dashboard (Fenrus replacement). Single-user,
zero build step (Vanilla JS + CSS Grid), gridstack.js editable grid, JWT auth,
atomic JSON file storage.

> **Status:** LOT 2 — advanced builtin widgets + generic settings modal (settingsSchema) +
> enriched `/api/widgets` manifest. Server stats are **phase 2** (deferred, not implemented).

## Stack

- **Backend:** Node.js (>= 20) + Hono + `@hono/node-server`
- **Auth:** JWT (`jsonwebtoken`), passwords hashed with `bcryptjs` (cost 12)
- **Frontend:** Vanilla JS + CSS Grid, `gridstack.js` v13 (vendored locally)
- **Storage:** atomic JSON files in `server/data/` (temp write + rename, `.bak` backup)
- **Deploy:** Docker (documented below, not part of this lot)

## Quick start

```bash
npm install
cp .env.example .env        # optional; sensible defaults are generated
npm start                   # or: npm run dev (auto-restart)
```

Open http://localhost:3000 — on first run you'll be prompted to create the
admin user/password (first-run setup).

## Environment variables (`.env`)

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `server/data` | JSON storage directory |
| `JWT_SECRET` | auto-generated | JWT signing secret (persisted to `data/config.json`) |
| `JWT_EXPIRES_IN` | `7d` | JWT expiration (e.g. `1h`, `7d`) |
| `BCRYPT_ROUNDS` | `12` | bcrypt cost factor |

## API overview

Public:
- `GET /api/health` — liveness
- `GET /api/auth/status` — first-run? (`{ firstRun: true }`)
- `POST /api/auth/setup` — create admin user (only when not configured)
- `POST /api/auth/login` — returns JWT (rate-limited: 5 tries / 15 min / IP)

Protected (JWT required):
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PUT /api/auth/credentials` — change user/password (current password required)
- `GET /api/layout`, `PUT /api/layout`
- `POST /api/layout/items`, `PATCH /api/layout/items/:id/config`, `DELETE /api/layout/items/:id`
- `GET /api/widgets` — widget type manifest (id, name, icon, category, defaultSize, settingsSchema)
- `GET /api/weather?city=…&units=metric|imperial` — weather proxy (open-meteo, no API key, cached 10 min)

## Widgets

Builtin widgets: `frame`, `shortcut`, `clock`, `iframe`, `links`, `search`, `notes`, `weather`.
Each widget exposes a declarative `settingsSchema` (field types: `text`, `number`, `select`,
`url`, `icon`, `color`, `toggle`, `textarea`, `list`) that drives the generic config modal —
no per-widget UI code. The weather widget fetches through the backend proxy to avoid CORS.

## Storage layout (`server/data/`)

- `config.json` — auth config (user, bcrypt hash, JWT secret, expiry)
- `layout.json` — grid layout (id/x/y/w/h/type/config)
- `*.bak` — previous version of each file (kept on write)

Writes are atomic: write to `*.tmp`, then `rename()` over the target, then
backup the previous version to `*.bak`. Layout writes are debounced server-side.

## Docker

A ready-to-run image is published to the GitHub Container Registry:

```
ghcr.io/grokuku/homy:latest
ghcr.io/grokuku/homy:<version>
```

### Quick start (Docker Compose)

```bash
docker compose up -d
```

> ℹ️ **Permissions**: the container runs **unprivileged as uid/gid 1000**, and Node never
> runs as root. Its entrypoint briefly starts as root to `chown -R 1000:1000` the
> mounted data directory, then drops privileges via `su-exec` before starting the app —
> so bind mounts owned by root work out of the box, with no manual `chown` on the host.
> If you prefer the container not to touch host permissions at all, swap the bind mount
> for a named volume in `docker-compose.yml` (`- homy-data:/data` + a `volumes: homy-data:` key).

Then open http://localhost:3000 — the first page is the setup screen (create the admin account).

### Quick start (plain Docker)

```bash
docker run -d --name homy \
  --restart unless-stopped \
  -p 3000:3000 \
  -v "$PWD/data:/data" \
  ghcr.io/grokuku/homy:latest
```

### Volume and environment

| Mount / variable | Default | Notes |
| --- | --- | --- |
| `/data` (volume) | — | `DATA_DIR`. Holds `config.json` (bcrypt hash + JWT signature secret), `layout.json` and uploaded backgrounds. **Must be mounted**, otherwise everything is lost on image upgrade. Ownership to uid/gid 1000 is fixed by the entrypoint at startup (see above). |
| `PORT` | `3000` | HTTP port inside the container |
| `DATA_DIR` | `/data` | Set by the image |
| `JWT_SECRET` | auto-generated | Persisted to `/data/config.json` on first run — set it only to inject your own |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `BCRYPT_ROUNDS` | `12` | bcrypt cost factor |

Build metadata is embedded as OCI labels (`version`, `git_commit`) and as `/app/version.txt`
inside the image. A `HEALTHCHECK` probes `GET /api/health`.

### Reaching other services

By default the container stays on its own network. To address other containers by name
(Docky, Pi-Web, …), attach it to your shared external network — uncomment the block in
`docker-compose.yml`.

### Building locally

```bash
docker build -t homy .
docker build \
  --build-arg VERSION=$(cat version.txt) \
  --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
  -t homy .
```

### Image build (CI)

Two **manually triggered** workflows in `.github/workflows/` follow the same principle as the
Docky project:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `test-build.yml` | manual | multi-arch build (`linux/amd64`, `linux/arm64`), pushes only `:test` |
| `release.yml` | manual | multi-arch build, pushes `:<version>` **and** `:latest`, then increments the patch in `version.txt` and commits it |

`version.txt` (repository root) is the single source of truth for the version: it is passed to
both builds as the `VERSION` build arg (`GIT_COMMIT` receives the short commit hash). Run
`test-build` to validate an image, then `release` to publish it.

## Project structure

```
Dockerfile                 # Node image: starts as root, entrypoint chowns /data then drops to uid 1000, HEALTHCHECK
docker-entrypoint.sh       # fixes data volume ownership, then su-exec → CMD as uid/gid 1000
.dockerignore              # keeps data/, node_modules/ and .env out of the context
docker-compose.yml         # deployment: bind mount ./data, port 3000
version.txt                # single source of truth for the version (CI)
.github/workflows/         # test-build.yml + release.yml (manual, ghcr.io)
server/
  index.js                 # Hono bootstrap, static, routes, error handler
  config.js                # env + config.json loader
  routes/                  # auth, layout, widgets
  middleware/              # JWT guard, rate-limit
  services/                # store (atomic JSON), auth
  data/                    # runtime JSON storage (gitignored)
public/
  index.html               # SPA: login view + dashboard view
  css/                     # styles
  js/
    api.js                 # fetch client
    state.js               # app state
    main.js                # bootstrap, login/dashboard switch
    grid/editor.js         # editable grid + palette
    grid/viewer.js         # locked grid
    ui/settingsModal.js    # generic schema-driven config modal
    ui/toast.js            # toast notifications
    widgets/registry.js    # widget type registry
    widgets/{shortcut,clock,frame,iframe,links,search,notes,weather}.js
  vendor/gridstack/        # vendored gridstack v13 (gridstack.min.js + gridstack.min.css)
```

## Security notes

- User data is injected via `textContent`/`setAttribute` (never unescaped `innerHTML`).
- URLs are validated to `http:`/`https:` before use.
- Mutations (layout PUT/PATCH) validate the Origin header.
- Passwords are bcrypt-hashed; JWT signed with a secret (auto-generated by default).
