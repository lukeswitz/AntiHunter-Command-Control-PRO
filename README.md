# AntiHunter Command & Control PRO

AntiHunter Perimeter Defense Systems — a full-stack command center for radio/mesh deployments built entirely with Node.js and TypeScript. The platform ingests live telemetry, renders nodes and geofences on a real-time map, orchestrates detection/command workflows, and provides rich operator tooling (alarms, inventory, exports, and audit trails).

> **No Python anywhere.** Serial ingest, protocol parsing, storage, and UI are all TypeScript-based for a single-language operational model.

---

## Table of Contents

1. [Overview](#overview)
2. [Feature Highlights](#feature-highlights)
3. [Architecture](#architecture)
4. [Repository Layout](#repository-layout)
5. [Prerequisites](#prerequisites)
6. [Platform Setup](#platform-setup)
7. [Installation](#installation)
8. [Configuration](#configuration)
9. [Database & Migrations](#database--migrations)
10. [Running the Stack](#running-the-stack)
11. [Running with Docker](#running-with-docker)
12. [Building for Production](#building-for-production)
13. [Serial Hardware & Meshtastic Sniffer](#serial-hardware--meshtastic-sniffer)
14. [Useful Scripts](#useful-scripts)
15. [Operations & Maintenance](#operations--maintenance)
16. [Troubleshooting](#troubleshooting)

---

## Overview

AntiHunter Command & Control PRO turns raw radio/mesh telemetry into actionable situational awareness. The application keeps track of nodes, devices, and geofences, allows operators to launch complex detection sequences, and streams alerts through a tone-aware alarm engine. Everything is multi-site aware and backed by Prisma/PostgreSQL for durability.

## Feature Highlights

- **Real-time node tracking:** live map, trails/history, dynamic radius pulses, and geofence focus.
- **Detection workflows:** configurable scan presets, baseline collection, drone/deauth/randomization pipelines.
- **Command console:** parameterized command templates, audit logs, FOREVER protections, and command lifecycle tracking.
- **Alarms:** volume/rate limit per level, default tones, custom WAV uploads, do-not-disturb windows, and configurable color pulses on the map.
- **Inventory & targets:** ingestion of target data, vendor/OUI resolution, promotion to targets, triangulation capture, and exports.
- **Multi-site aware:** each site can have bespoke serial/MQTT configuration, coverage overrides, and admin assignments.
- **User management:** profile updates, admin console for user creation/role management, per-user preferences (theme, density, time format).
- **Geofence automation:** per-geofence alarms with enter/exit triggers, map focus highlights, and wizard-driven geometry authoring.
- **Operations controls:** API and UI actions to clear nodes, manage coverage, and import/export settings.

## UI Modules at a Glance

Each primary view ships with rich operator context. Replace the placeholder images below with real screenshots once the UI is finalized.

#### Map
Tracks live nodes, renders trails and geofences, and highlights alerts in real time.

![Map Placeholder](docs/media/map-placeholder.png)

#### Console
Launch commands, manage templates, and review command acknowledgements/audits.

![Console Placeholder](docs/media/console-placeholder.png)

#### Inventory
Review discovered devices, signal strength history, vendor resolutions, and export datasets.

![Inventory Placeholder](docs/media/inventory-placeholder.png)

#### Targets
Promote detections to tracked targets, view triangulation results, and manage status notes.

![Targets Placeholder](docs/media/targets-placeholder.png)

#### Geofence
Create and edit geofences, tune alarm behavior, and jump to polygons on the map.

![Geofence Placeholder](docs/media/geofence-placeholder.png)

#### Nodes
Audit node health, connectivity, and telemetry history with quick map focus actions.

![Nodes Placeholder](docs/media/nodes-placeholder.png)

#### Scheduler
Plan recurring scans, FOREVER tasks, and automated detection sequences.

![Scheduler Placeholder](docs/media/scheduler-placeholder.png)

#### Config
Adjust system defaults (alarms, detection presets, serial ports, site federation) from a single pane.

![Config Placeholder](docs/media/config-placeholder.png)

#### Exports
Generate CSV/GeoJSON bundles for inventory, targets, commands, and audit logs.

![Exports Placeholder](docs/media/exports-placeholder.png)

#### Account
Manage your profile, theme preferences, and admin-level user management tasks.

![Account Placeholder](docs/media/account-placeholder.png)


## Architecture

| Layer      | Technology | Notes |
|------------|------------|-------|
| **Backend** | NestJS, Prisma, Socket.IO | REST + WS APIs, serial ingest worker, command queue, alarm service |
| **Database** | PostgreSQL | Prisma migrations, seeds for singleton config tables, audit trail |
| **Frontend** | React (Vite), Zustand, React Query, Leaflet (map) | SPA with map, targets, inventory, console, config modules |
| **Tooling** | pnpm workspace, TypeScript strict mode, ESLint/Prettier | developer experience, linting, formatting |

Data flows from serial workers → Prisma (nodes/device tables) → WS events → Zustand stores → React components. Commands and alarms run in the opposite direction, bubbling from the UI down to the serial layer.

## Repository Layout

```
.
├─ apps/
│  ├─ backend/           # NestJS app, Prisma schema, serial services
│  └─ frontend/          # Vite SPA with React routes/stores
├─ tools/
│  └─ meshtastic-sniffer.ts  # standalone CLI to capture serial packets
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ README.md
```

## Prerequisites

- **Node.js** 20 or newer (ships with Corepack for pnpm)
- **pnpm** 9 or newer (`corepack enable` sets it up automatically)
- **PostgreSQL** 14+ (local or managed)
- Build toolchain:
  - Linux: `build-essential`, `pkg-config`, `libssl-dev`
  - macOS: Xcode command-line tools
  - Windows: automatic install via Node.js (or Visual Studio Build Tools)
- Optional: Docker Desktop (for Postgres), Git, serial drivers (FTDI/CH340)

## Platform Setup

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y curl git build-essential pkg-config libssl-dev \
    python3 make gcc g++ postgresql-client
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
corepack prepare pnpm@latest --activate
sudo usermod -aG dialout "$USER"   # access to /dev/ttyUSB*
```

### macOS

```bash
xcode-select --install
brew install node@20 pnpm git postgresql
brew services start postgresql
```

### Windows 10/11 (PowerShell)

```powershell
# Install Node.js 20+ from https://nodejs.org
corepack enable
corepack prepare pnpm@latest --activate
git clone https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git
# Optional: Docker Desktop for Postgres
# Serial ports appear under Device Manager -> Ports (COM & LPT)
```

> **WSL2**: Use the Linux instructions inside WSL. For USB passthrough, either run the backend on Windows or enable USBIP (`usbipd-win`).

## Installation

```bash
git clone https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git
cd AntiHunter-Command-Control-PRO
pnpm install
```

## Configuration

Create `apps/backend/.env`:

```
DATABASE_URL="postgresql://cc_user:cc_pass@localhost:5432/command_center"
PORT=3000
HTTP_PREFIX=api
LOG_LEVEL=info
SERIAL_DEVICE=/dev/ttyUSB0        # leave blank for UI-only development
SERIAL_BAUD=115200
ALLOW_FOREVER=true
ALLOW_ERASE_FORCE=false
```

Optional environment flags:

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | If auth is enabled later |
| `SITE_ID` | Default site for ingest |
| `WS_MAX_CLIENTS` | Socket.IO connection limit |
| `SERIAL_PROTOCOL` | Parser profile (`meshtastic-like`, `nmea-like`, etc.) |

Frontend currently consumes backend settings via API, so no extra `.env` is needed.

## Database & Migrations

All Prisma migrations and seed scripts live in `apps/backend/prisma`. Run once after configuring Postgres:

```bash
cd apps/backend
pnpm prisma:generate
pnpm prisma:migrate
pnpm prisma:seed
```

Seed inserts singleton config rows (AppConfig, AlarmConfig, VisualConfig, CoverageConfig) plus a default site and admin user stub.

## Running the Stack

Open two terminals:

```bash
# Terminal 1 – backend API + WebSocket + serial worker
cd apps/backend
pnpm dev     # http://localhost:3000

# Terminal 2 – frontend SPA
cd apps/frontend
pnpm dev     # http://localhost:5173
```

The Vite dev server proxies `/api/*`, `/healthz`, `/readyz`, `/metrics`, `/socket.io` back to the NestJS service so CORS is not a concern in development.

## Running with Docker

> Tested with Docker Engine 25+ and Compose V2. Make sure virtualization is enabled and (on Windows/macOS) that file sharing is configured for the repository folder.

### 1. Prerequisites

- Docker Desktop (Windows/macOS) **or** Docker Engine (Linux).
- Docker Compose V2 (bundled with recent Docker releases). Verify with:
  ```bash
  docker compose version
  docker info
  ```

### 2. Clone and prepare the repo

```bash
git clone https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git
cd AntiHunter-Command-Control-PRO
```

Optional: copy the sample Docker environment file and adjust credentials/secrets before the first run.

```bash
cp docker/.env.example docker/.env.local
# edit docker/.env.local with your DATABASE_URL, JWT secret, etc.
```

Compose auto-loads `.env` files adjacent to `docker-compose.yml`. To use the custom file above, launch with `docker compose --env-file docker/.env.local …`. If you skip this step the defaults baked into `docker-compose.yml` are used (admin email `admin@example.com`, password `admin`).

### 3. Build the images

```bash
docker compose build
# or if you created docker/.env.local:
docker compose --env-file docker/.env.local build
```

This compiles the backend (NestJS) and frontend (Vite) and caches dependencies in intermediate layers.

### 4. Start the stack

```bash
docker compose up -d
# or with a custom env file
docker compose --env-file docker/.env.local up -d
```

- `cc_postgres` stores data in the `postgres-data` named volume.
- `cc_backend` runs Prisma migrations on boot (`RUN_MIGRATIONS=true` by default) and exposes HTTP/WebSocket on `http://localhost:3000`.
- `cc_frontend` serves the SPA on `http://localhost:8080` and proxies API calls to the backend.

On first boot the seed script provisions:

| Variable | Default | Override |
|----------|---------|----------|
| `ADMIN_EMAIL` | `admin@example.com` | set `ADMIN_EMAIL` in your env file |
| `ADMIN_PASSWORD` | `admin` | set `ADMIN_PASSWORD` in your env file |

Log in at `http://localhost:8080` with those credentials and change the password immediately.

### 5. Monitor logs

```bash
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

When the backend finishes migrations you should see `Starting backend...` followed by NestJS bootstrap output.

### 6. Stop and clean up

```bash
docker compose down
```

Add `--volumes` if you also want to delete the Postgres data volume.

### Customizing the deployment

- **Environment overrides:** edit the `environment` block in `docker-compose.yml`, supply an override file (e.g. `docker-compose.override.yml`), or use `--env-file` as noted above. Common overrides include `LOG_LEVEL`, `SERIAL_DEVICE`, `ALLOW_FOREVER`, and mail server settings.
- **Serial passthrough (Linux):** add the following to the `backend` service and ensure the container user can access the device:
  ```yaml
  devices:
    - "/dev/ttyUSB0:/dev/ttyUSB0"
  group_add:
    - dialout
  ```
  On macOS/Windows Docker Desktop, direct serial passthrough is not supported; run the backend natively or via WSL if hardware access is required.
- **Skipping migrations:** set `RUN_MIGRATIONS=false` if you manage schema deploys externally.
- **Live reload:** the Docker workflow runs compiled artefacts. For day-to-day development, prefer the pnpm workflow described earlier (`pnpm dev` + hot reload).

## Building for Production

```bash
# Build backend bundle (dist/)
cd apps/backend
pnpm build

# Build frontend assets (dist/)
cd ../frontend
pnpm build
```

Serve `apps/frontend/dist` with your preferred static host (Nginx, S3, etc.) and run `node dist/main.js` for the backend (or deploy via PM2/systemd).

## Serial Hardware & Meshtastic Sniffer

1. Connect the radio/mesh device via USB and note the port (`/dev/ttyUSB0`, `COM6`, etc.).
2. Update `SERIAL_DEVICE`/`SERIAL_BAUD` in the backend `.env`.
3. Start the backend; the serial worker auto-connects and begins ingest.
4. Use the built-in tool for raw capture:

```bash
pnpm tool:sniffer -- --port /dev/ttyUSB0 --baud 921600
# Additional flags: --output file.log --json --no-stdout --delimiter "\r\n"
```

The sniffer is a zero-dependency TypeScript script that mirrors frames to stdout and a log file for parser development.

## Useful Scripts

| Command | Description |
|---------|-------------|
| `pnpm lint` | ESLint across backend + frontend |
| `pnpm format` | Prettier writes |
| `pnpm --filter @command-center/backend prisma:studio` | Inspect DB via Prisma Studio |
| `pnpm --filter @command-center/backend prisma:seed` | Reseed config rows |
| `pnpm --filter @command-center/frontend preview` | Preview SPA production build |

## Operations & Maintenance

- **Clearing nodes:** The UI invokes `DELETE /nodes`, which now removes rows from `Node`, `NodePosition`, `NodeCoverageOverride`, and `TriangulationResult` tables in addition to clearing the in-memory cache. This prevents stale nodes from reappearing when new telemetry arrives.
- **Geofence focus:** Clicking **Focus** zooms/frames the polygon and highlights it for 10 seconds. No stale highlights remain thanks to background pruning.
- **Alarm profiles:** Uploading a new tone immediately swaps the preview audio; re-running the preview reflects custom volume settings.
- **Configuration cards:** Each card has expanded width (min 360px) so action buttons remain inside the panel even in dark mode.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Build warns about CSS backticks | Update to latest README instructions (no more `` `n `` artifacts) |
| Serial port permission denied (Linux) | Add user to `dialout` and re-login (`sudo usermod -aG dialout $USER`) |
| Backend fails to start (`DATABASE_URL`) | Ensure Postgres is reachable and migrations have run |
| Targets/nodes reappear after clearing | Confirm backend is on latest code — clearing now removes DB + cache entries |
| Custom alarm volume not applied | Ensure upload succeeded; new implementation reloads and applies the config immediately |
| Large JS bundle warning | Vite warns for bundles >500 kB; consider future code-splitting if necessary |
| `tsc` not found when running scripts | Use `pnpm --filter <pkg> run build` (Corepack installs TypeScript locally per workspace) |

---

Feel free to extend any module—serial ingest, map rendering, exports, or auth. Keep the SRS as the north star and continue iterating on automation, telemetry, and operator tooling.

