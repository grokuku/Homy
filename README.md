# Homy

Custom self-hosted browser homepage dashboard (Fenrus replacement). Single-user,
zero build step (Vanilla JS + CSS Grid), gridstack.js editable grid, JWT auth,
atomic JSON file storage.

> **Status:** LOT 3 — themes (dark/light via CSS tokens), translucent widget surfaces with
> backdrop-blur, image & animated procedural backgrounds. Lots 1–2: editable grid, JWT auth,
> builtin widgets, generic settings modal (settingsSchema). Server stats are **phase 2**
> (deferred, not implemented).

## Stack

- **Backend:** Node.js (>= 20) + Hono + `@hono/node-server`
- **Auth:** JWT (`jsonwebtoken`), passwords hashed with `bcryptjs` (cost 12)
- **Frontend:** Vanilla JS + CSS Grid, `gridstack.js` v13 (vendored locally), plus holaf-lib bricks (modal/toast/color/tokens/ambient/icons vendored in `public/vendor/holaf/`)
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
- `GET /api/themes` — available themes (`['dark', 'light']`)
- `GET /api/settings` / `PUT /api/settings` — dashboard settings (theme, background); PUT validates strictly (400 on invalid values)
- `POST /api/backgrounds` — multipart upload of a background image (png/jpg/jpeg/webp/avif, magic-bytes checked, max 10 MB, max 20 files)
- `GET /api/backgrounds` — list uploaded backgrounds
- `DELETE /api/backgrounds/:name` — delete one (409 if currently referenced by the settings)

Public (by design):
- `GET /backgrounds/:name` — the uploaded background images themselves. Served WITHOUT the JWT
  because `<img>`/CSS layers cannot attach an Authorization header. See Security notes.

## Widgets

Builtin widgets: `frame`, `shortcut`, `clock`, `iframe`, `links`, `search`, `notes`, `weather`.
Each widget exposes a declarative `settingsSchema` (field types: `text`, `number`, `select`,
`url`, `icon`, `color`, `toggle`, `textarea`, `list`) that drives the generic config modal —
no per-widget UI code. The weather widget fetches through the backend proxy to avoid CORS.

Every widget also gets a **common appearance section** in the ⚙ modal, merged centrally into
its `settingsSchema` (server manifest + frontend registry, kept in sync):

- `bgColor` — background color (leave empty to use the theme default)
- `bgOpacity` — background opacity in % (0–100, only applies when a `bgColor` is set)
- `borderColor` — border color (leave empty to use the theme default)
- `textColor` — text color (leave empty to use the theme default)

These are applied per-widget via inline CSS custom properties (`--widget-bg-color`,
`--widget-bg-op`, `--widget-border-color`, `--widget-text-color`) with theme fallbacks, so
widgets without a custom appearance keep the default look.

## Storage layout (`server/data/`)

- `config.json` — auth config (user, bcrypt hash, JWT secret, expiry)
- `layout.json` — grid layout (id/x/y/w/h/type/config)
- `settings.json` — dashboard settings (`{ theme, background }`, lot 3)
- `backgrounds/` — uploaded background images as `<uuid>.<ext>` (served publicly under `/backgrounds/`)
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
scripts/
  check-schema-sync.mjs    # fails if the duplicated widget settingsSchema drifts (server ↔ front)
server/
  index.js                 # Hono bootstrap, static, routes, error handler
  config.js                # env + config.json loader
  routes/                  # auth, layout, widgets, settings, backgrounds
  middleware/              # JWT guard, rate-limit
  services/                # store (atomic JSON), auth, settings
  data/                    # runtime JSON storage + backgrounds/ (gitignored)
public/
  index.html               # SPA: login view + dashboard view (+ anti-flash theme script)
  css/style.css            # tokens (:root dark, [data-theme="light"]), surfaces, background layers
  js/
    api.js                 # fetch client (+ multipart upload)
    state.js               # app state (incl. dashboard settings)
    main.js                # bootstrap, login/dashboard switch, editor toolbar (Background/Theme)
    grid/editor.js         # editable grid + palette
    grid/viewer.js         # locked grid
    backgrounds/manager.js # background layers: image (+dim/blur) & procedural canvas (holaf-ambient)
    ui/theme.js            # tokens aliasing (HolafTokens), dark/light switch, Holaf modal/toast themes
    ui/backgroundModal.js  # "Background" modal (type/image/procedural, upload, blur/dim)
    ui/settingsModal.js    # generic schema-driven config modal (HolafModal shell)
    ui/toast.js            # toast notifications (HolafToast backend)
    widgets/registry.js    # widget type registry (+ per-widget appearance)
    widgets/{shortcut,clock,frame,iframe,links,search,notes,weather}.js
  vendor/gridstack/        # vendored gridstack v13 (gridstack.min.js + gridstack.min.css)
  vendor/holaf/            # vendored holaf-lib bricks (modal .0.4.0, toast 0.5.0, color 0.1.0,
                           #   tokens/ambient/icons 0.1.0) + holaf-manifest.json pinning versions
```

## Themes & backgrounds (lot 3)

**Tokens & themes.** `public/css/style.css` defines the token contract: `:root` holds the dark
palette as *fallbacks* aliased to the vendored holaf-tokens brick's reserved `--holaf-*` prefix
(`--bg: var(--holaf-surface, #0f1115)`, …), and `[data-theme="light"]` overrides them with the
light fallbacks. At runtime `ui/theme.js` applies two named palettes through
`HolafTokens.setTokens({ name: 'homy' | 'homy-light', values })` (hover derivatives computed with
`HolafColor.mix`), replays `HolafModal.setTheme` / `HolafToast.setTheme` so open modals and toasts
follow, and mirrors the choice in `localStorage['homy-theme']`. That mirror is applied by a tiny
inline script in `<head>` **before the CSS** (anti-flash, including on the login view); once
authenticated, the server settings (`GET /api/settings`) are the source of truth and refresh the
mirror. The "Theme" button lives in the edit-mode toolbar; persistence goes through
`PUT /api/settings`.

**Translucent surfaces.** When a background (image or procedural) is active, `<body>` gets
`data-bg-active`: the widget surface fallback opacity becomes `var(--surface-alpha)` (80%) and
`backdrop-filter: blur(14px) saturate(1.2)` is enabled on `.grid-stack-item-content`. The
per-widget appearance (⚙ modal: `bgColor`/`bgOpacity`) always wins over the global translucency —
a widget configured with e.g. an orange background at 60% keeps exactly `rgba(255,136,0,0.6)`.

**Image backgrounds.** Uploaded via the "Background" modal (or `POST /api/backgrounds`), stored as
`DATA_DIR/backgrounds/<uuid>.<ext>`, served publicly under `/backgrounds/*` (see Security notes).
Options: blur 0–20 px, dark dim overlay 0–80 %, fixed to viewport or scrolling. Deleting a
background currently referenced by the settings is refused (409) — an explicit choice, no cascade.

**Procedural backgrounds.** Three canvas 2D generators provided by the vendored holaf-ambient
brick: `waves` (liquid ribbons), `particles` (depth-based glows + optional links), `aurora`
(drifting light sheets, transparent). Options: `speed`, `density` (a single intensity slider
1–100 that maps to a sensible element count per generator), `opacity`, `blur` (0–40 px, global
softening), `links` (particles only), plus a palette preset or custom hex colors. The modal shows
a **live preview** driven by the brick itself, so the setting you see is the one applied on Save.
The brick owns the performance contract: devicePixelRatio-aware sizing (ResizeObserver), rAF loop
paused on `visibilitychange`, a single static frame under `prefers-reduced-motion`, dt-based clock
(frame-rate independent), and a clean `destroy()` on background change. Type "none" removes every
layer and the canvas.

**Brick version.** `vendor/holaf/holaf-ambient.js` is a pinned copy (see
`vendor/holaf/holaf-manifest.json`): check/upgrade with `holaf-lib/scripts/holaf check|upgrade
ambient /projects/Homy/public`.

## Security notes

- User data is injected via `textContent`/`setAttribute` (never unescaped `innerHTML`).
- URLs are validated to `http:`/`https:` before use.
- Mutations (layout PUT/PATCH, settings PUT) validate the Origin header.
- Passwords are bcrypt-hashed; JWT signed with a secret (auto-generated by default).
- **Background images are PUBLIC**: they are served under `/backgrounds/*` with no JWT, because
  `<img>` tags and CSS `background-image` cannot attach an `Authorization` header. The exposure
  is mitigated by (a) filenames being non-guessable random UUIDs minted server-side
  (`<uuid>.<ext>`, never user-supplied), (b) a strict extension whitelist (png/jpg/jpeg/webp/avif)
  with a magic-bytes check at upload, (c) a 10 MB per-file limit and a 20-file quota, and
  (d) `DELETE /api/backgrounds/:name` being JWT-protected with a strict UUID-name validation
  (path-traversal safe) and a 409 when the file is currently referenced by the settings. If your
  instance is reachable from the public internet, assume the images are enumerable/fetchable by
  anyone who learns a URL.
- `data/` (auth config, layouts, settings) is never served statically — only `public/` is.
