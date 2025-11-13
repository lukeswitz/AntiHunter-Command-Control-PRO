<p align="center">
  <img src="TopREADMElogo.png" alt="AntiHunter Command Center Logo" width="320" />
</p>

<h1 align="center">AntiHunter Command & Control PRO</h1>

> The operations hub for AntiHunter SIGINT meshes – live telemetry, drones, geofences, alarms, and integrations in one place.

AntiHunter Command & Control PRO ingests serial/MQTT telemetry from AntiHunter detection nodes, enriches it with FAA data, manages geofences and alarms, and gives operators a single interface to orchestrate drone interception workflows. This README serves as a practical guide: install, configure, operate, and extend the platform with confidence.

---

## Contents

1. [At a Glance](#at-a-glance)
2. [Key Capabilities](#key-capabilities)
3. [Architecture Overview](#architecture-overview)
4. [Repository Layout](#repository-layout)
5. [Prerequisites](#prerequisites)
6. [Installation & Initialization](#installation--initialization)
7. [Configuration](#configuration)
   - [Environment Flags & Feature Switches](#environment-flags--feature-switches)
   - [Drone & FAA Quick Steps](#drone--faa-quick-steps)
8. [Running the Stack](#running-the-stack)
   - [Developer Mode](#developer-mode)
   - [Production Builds](#production-builds)
   - [Docker Compose](#docker-compose)
9. [Core Features](#core-features)
   - [Live Map & Nodes](#live-map--nodes)
   - [Drone Tracker & Inventory](#drone-tracker--inventory)
   - [FAA Registry Integration](#faa-registry-integration)
   - [Inventory & Targets](#inventory--targets)
   - [Command Console](#command-console)
   - [Geofences & Alarms](#geofences--alarms)
   - [Integrations (Serial, MQTT, TAK, WebSockets)](#integrations-serial-mqtt-tak-websockets)
   - [Security & Auditing](#security--auditing)
10. [Operations Playbook](#operations-playbook)
11. [Testing & Simulation](#testing--simulation)
12. [Troubleshooting](#troubleshooting)
13. [Legal](#legal)

---

## At a Glance

| Item                       | Details                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| **Backend**                | NestJS + Prisma + PostgreSQL                                                             |
| **Frontend**               | React + Vite + Leaflet                                                                   |
| **Package manager**        | `pnpm`                                                                                   |
| **Serial ingest**          | Meshtastic-like frames over USB/serial or simulator                                      |
| **Integrations**           | TAK/CoT bridge, MQTT federation, FAA registry, SMTP                                      |
| **Environments**           | Local dev (`pnpm AHCC`), Docker Compose, production builds                               |

---

## Key Capabilities

- **Live SA map** with node trails, signal pulses, geofence overlays, alert focus, and drone approach vectors.
- **Drone Tracker & Inventory drawer** that auto-opens on detections, exposes headings, FAA data, status controls, and map focus buttons.
- **FAA registry enrichment** supporting offline `MASTER.txt` imports and online uasdoc lookups with caching and throttling.
- **Inventory & targets** pipeline with vendor/OUI lookup, promotion workflows, exports, and map sync.
- **Command console** for scan/baseline/deauth payloads, audit streams, FOREVER protection, and ACK/RESULT relays.
- **Alarm engine** with severity-specific tones, drone geofence breach sound slots, do-not-disturb windows, and live previews.
- **Integrations**: TAK bridge with per-stream toggles, MQTT federation with retrying subscriptions, serial auto-reconnect, and websocket broadcasts.
- **Security posture** featuring MFA, rate limiting, adaptive firewall rules, lockouts, and audit logging.

---

## Architecture Overview

```
Mesh Nodes -+
            +-> Serial Service -+
MQTT Sites -+                   ¦        +-> TAK Bridge
                                 +-> Ingest Pipeline --> Prisma/PostgreSQL --> API / WebSockets
FAA Online API --------+        ¦        +-> Alarm/Events -> Frontend
FAA Offline Dataset -+ ¦        ¦
Simulator / Tools --------------+
```

- **Backend** handles ingest, persistence, FAA enrichment queues, alarm routing, and integrations.
- **Frontend** consumes REST + WebSockets for live state, renders the map, drone drawer, inventory, targets, and config consoles.
- **Scripts** (sniffer, simulator, db helper) support testing and maintenance without field hardware.

---

## Repository Layout

```
apps/
  backend/     # NestJS service, Prisma schema, migrations
  frontend/    # React SPA (Vite)
  ...
scripts/       # Simulator, DB helper, utilities
images/        # README screenshots assets
```

---

## Prerequisites

| Requirement          | Notes                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------- |
| Node.js 20 LTS       | Matches current Toolchain (ts-node-dev, Vite, Prisma).                                |
| pnpm = 9             | Workspace-aware installs.                                                              |
| PostgreSQL 15+       | Development database (localhost by default).                                          |
| Git, bash/PowerShell | For cloning and running scripts.                                                       |
| Optional tooling     | Docker (for compose), mkcert/OpenSSL (for HTTPS), Meshtastic hardware for live ingest. |

---

## Installation & Initialization

```bash
git clone https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO.git
cd AntiHunter-Command-Control-PRO
pnpm install
```

Initialize Prisma (local dev):

```bash
cd apps/backend
pnpm prisma migrate dev
pnpm prisma generate
```

Seed defaults if needed (optional, requires db creds in `.env`):

```bash
pnpm --filter @command-center/backend prisma:seed
```

---

## Configuration

1. Copy `apps/backend/.env.example` (or reference values below) into `apps/backend/.env`.
2. Adjust site ID, DB URL, serial defaults, MQTT/TAK creds, FAA settings, etc.
3. Optionally create repo-root `.env` for shared defaults and `apps/backend/prisma/.env` for Prisma CLI.

Example `apps/backend/.env` (trim to your needs):

```env
DATABASE_URL="postgresql://command_center:command_center@localhost:5432/command_center"
PORT=3000
HTTP_PREFIX=api
SITE_ID=alpha
LOG_LEVEL=info

# Serial bootstrap defaults
SERIAL_DEVICE=COM11
SERIAL_BAUD=115200
SERIAL_DATA_BITS=8
SERIAL_PARITY=none
SERIAL_STOP_BITS=1
SERIAL_DELIMITER=\n
SERIAL_RECONNECT_BASE_MS=1000
SERIAL_RECONNECT_MAX_MS=15000
SERIAL_RECONNECT_JITTER=0.2
SERIAL_PROTOCOL=meshtastic-like

# Feature toggles
DRONES_RECORD_INVENTORY=true
FAA_ONLINE_LOOKUP_ENABLED=true
FAA_ONLINE_CACHE_TTL_MINUTES=60
FAA_ONLINE_LOOKUP_COOLDOWN_MINUTES=10
```

### Environment Flags & Feature Switches

| Variable | Description |
| --- | --- |
| `DRONES_RECORD_INVENTORY` | Automatically create/update Inventory entries whenever a drone telemetry frame carries a MAC + reporting node. |
| `FAA_ONLINE_LOOKUP_ENABLED` | Toggle internet-based RID lookups via `https://uasdoc.faa.gov/listDocs/{RID}`. |
| `FAA_ONLINE_CACHE_TTL_MINUTES` | Minutes to cache successful FAA matches. |
| `FAA_ONLINE_LOOKUP_COOLDOWN_MINUTES` | Cooldown before retrying a RID/MAC lookup. |
| `SERIAL_*` | Default serial device, baud, delimiter, reconnect behavior (seeded once, editable in UI). |
| `TAK_*` | Protocol/host/credentials for the TAK bridge. |
| `JWT_SECRET`, `TWO_FACTOR_*`, `AUTH_*` | Harden authentication & lockouts. |
| `HTTPS_*` | Enable TLS termination directly in the backend. |
| `RATE_LIMIT_*`, `MAIL_*`, `SECURITY_ALERT_RECIPIENTS` | Operational guardrails & notifications. |

_The backend reads env vars in this order: repo-root `.env` ? `apps/backend/.env` ? Prisma `.env` (CLI only)._ 

### Drone & FAA Quick Steps

1. **Mirror detections into Inventory** – set `DRONES_RECORD_INVENTORY=true` and restart the backend. Clearing Inventory now flushes in-memory drones and map markers until fresh telemetry arrives.
2. **Seed FAA data offline** – download [ReleasableAircraft.zip](https://registry.faa.gov/database/ReleasableAircraft.zip) and upload it (or `MASTER.txt`) via **Config ? FAA Registry**. Progress + cached counts display in the card.
3. **Online lookups** – keep `FAA_ONLINE_LOOKUP_ENABLED=true` to augment offline data whenever internet is available. Cooldown + TTL envs control the queue.
4. **Drone geofence alarms** – configure the dedicated "Drone Geofence Breach" slot under **Config ? Alarms**, including custom audio.

---

## Running the Stack

### Developer Mode

```bash
pnpm AHCC
```

- Spawns backend (`ts-node-dev`) and frontend (Vite) in parallel.
- Backend: `http://localhost:3000/api`; Frontend: `http://localhost:5173`.
- Log in with the seeded admin (from `pnpm prisma:seed`) or create a user via CLI/DB.

### Production Builds

```bash
pnpm --filter @command-center/backend build
pnpm --filter @command-center/frontend build
```

Serve the backend via `node dist/main.js` (behind reverse proxy/TLS). Host the frontend `dist/` assets via nginx, S3, etc.

### Docker Compose

1. Copy/edit `docker-compose.yml` (contains Postgres + backend + frontend services).
2. Provide environment files for the backend service (mount `.env`).
3. `docker compose up -d`
4. For Prisma seeding inside the container:

```bash
docker compose exec backend sh -lc "cd /app && pnpm install --filter @command-center/backend --prod=false --ignore-scripts && pnpm --filter @command-center/backend prisma:seed"
```

---

## Core Features

### Live Map & Nodes

- Leaflet map with base layer selector (Carto dark/light, OSM, etc.).
- Node markers show site color, trail history, last telemetry timestamp, and severity pulses.
- Clicking a geofence or node pans/zooms and surfaces contextual actions.

![Map view](images/Map.png)

### Drone Tracker & Inventory

- Drone detections open the **Drone Tracker & Inventory** drawer automatically. Each row contains:
  - Drone RID + MAC, current heading (e.g., "NE"), speed/altitude, FAA metadata, operator coordinates, signal (RSSI), and timestamps.
  - Status selector (Friendly / Neutral / Hostile / Unknown) that writes through to `/api/drones/:id/status` and recolors map dots immediately.
  - "Focus" button to pan the map to the drone or operator.
- Hostile rows pulse red; Friendly/Neutral adopt their palette; Unknown defaults to blue (matching the map markers).
- Drawer can be reopened by clicking any drone/operator marker or pressing the map action button.
- Clearing Inventory removes drones/operators from the map and store until new telemetry arrives.

### FAA Registry Integration

- **Offline**: upload the official `ReleasableAircraft.zip` (or individual `MASTER.txt`). The backend parses it asynchronously, stores normalized summaries, and annotates drones with registrant/craft names.
- **Online**: when enabled, the FAA lookup queue contacts `https://uasdoc.faa.gov/listDocs/{RID}` for missing entries, caches results for the configured TTL, and respects a per-RID cooldown. Lookups are throttled so ingest remains real-time.
- FAA results propagate to WebSocket/MQTT payloads, drone drawer, inventory rows, and tooltips.

### Inventory & Targets

- Detections with MAC addresses land in Inventory (when `DRONES_RECORD_INVENTORY=true`). Operators can add notes, tags, and promote entries to tracked targets.
- Promotion surfaces the craft on the map with additional context (OUI vendor, trails, signal history). Inventory exposes exports and vendor statistics.
- Clearing inventory triggers drone removal events plus DB cleanup.

### Command Console

- Parameterized commands (scan, baseline, deauth, etc.) with FOREVER protection and auditing.
- Displays ACK/RESULT streams, raw logs, and allows replay/resend.
- Integrates with TAK for mirrored command notifications.

### Geofences & Alarms

- Wizard-driven polygon editing, color controls, enter/exit triggers, and per-geofence alarm levels.
- Drone position is evaluated against every geofence, and breaches trigger the dedicated alarm slot plus map glow.
- Alarm provider supports severity-specific WAV uploads, preview audio, custom volume, and rate limiting.

### Integrations (Serial, MQTT, TAK, WebSockets)

- **Serial**: single persistent config row; auto-detect ports; reset to env defaults; ingest buffer + concurrency controls; simulator posts to `/api/serial/simulate`.
- **MQTT federation**: publishes local drone telemetry to `ahcc/<site>/drones/upsert`, subscribes to remote sites with exponential backoff (skips local site). Attach/detach logging clarifies failures.
- **TAK bridge**: per-stream toggles (nodes, targets, drone alerts, command ACK/RESULT), restart button, TLS/user/pass support.
- **WebSockets**: `CommandCenterGateway` streams drone upserts/removals, node updates, inventory changes, alarms, etc.

### Security & Auditing

- MFA (TOTP) with encrypted seeds, recovery codes, drift controls.
- Rate limiting per route + honeypot heuristics for forms.
- Adaptive firewall (geo/IP allowlists/denylists, fail/ban windows).
- Audit tables for commands, targets, logins, and config changes.

---

## Operations Playbook

### Useful Scripts

| Command | Description |
| --- | --- |
| `pnpm AHCC` | Start backend + frontend dev servers in parallel. |
| `pnpm lint` | ESLint across backend & frontend. |
| `pnpm format` | Prettier formatting. |
| `pnpm --filter @command-center/backend prisma:studio` | Launch Prisma Studio. |
| `pnpm --filter @command-center/backend prisma:seed` | Seed config rows / admin user. |
| `node scripts/db-update-helper.mjs` | Interactive CLI to apply/rebase migrations or reset the schema. |
| `pnpm tool:sniffer -- --port /dev/ttyUSB0 --baud 921600` | Serial sniffer for Meshtastic-like frames (supports `--output`, `--json`). |
| `pnpm exec node scripts/drone-simulator.cjs --token "<JWT>" [options]` | Push simulated mesh lines (node bootstrap + drone telemetry) into `/api/serial/simulate`. |

### Routine Tasks

- **Apply migrations**: `pnpm prisma migrate deploy` (prod) or `pnpm prisma migrate dev` (local).
- **Regenerate Prisma client**: `pnpm prisma generate` anytime `schema.prisma` changes.
- **Clear stale nodes/drones**: UI buttons invoke backend services that drop DB rows and emit removal events so markers disappear until rediscovered.
- **Rotate FAA dataset**: re-upload `MASTER.txt` whenever the FAA publishes a new release.

---

## Testing & Simulation

### Drone Simulator

1. Obtain an ADMIN JWT (log in via `/api/auth/login`).
2. Run:

   ```bash
   pnpm exec node scripts/drone-simulator.cjs \
     --token "$ADMIN_JWT" \
     --drone-id 1581F5FJD239C00DW22E \
     --mac 60:60:1F:30:2C:3D \
     --node AH99 \
     --node-lat 40.7138 \
     --node-lon -74.0050 \
     --iterations 60
   ```

   Defaults: message every 5?s, 50–70?km/h approach, operator radius 450?m, spawn distance 1100?m. Override `--start-distance`, `--operator-radius`, `--speed-kmh-min/max`, etc.

3. Watch backend logs for `/api/serial/simulate` requests, FAA enrichment, drone upserts, and inventory entries. Frontend map + Drone Tracker should visualize the drone immediately.

### Serial Sniffer

```bash
pnpm tool:sniffer -- --port /dev/ttyUSB0 --baud 921600 --output logs/meshtastic.log
```

Streams frames to stdout and optionally writes structured JSON for parser tuning.

---

## Troubleshooting

| Symptom | Possible Fix |
| --- | --- |
| Frontend proxy errors (`ECONNREFUSED`) | Backend not listening yet. Wait for Nest “Ready” log or check `PORT`/firewall. |
| Prisma `P2022`/missing columns | Run latest migrations (`pnpm prisma migrate deploy`). Verify the DB schema matches committed migrations. |
| Drone drawer empty despite telemetry | Ensure `DRONES_RECORD_INVENTORY=true` (if you expect Inventory rows) and that telemetry includes MAC + node id. Check serial logs for parser errors. |
| FAA lookups stuck | Confirm outbound internet, or disable online lookup to rely on offline cache. Review `FAA_ONLINE_*` envs. |
| MQTT "Subscribe error" | Broker ACLs may block local site subscriptions; the service now skips local site topics and retries remote ones with exponential backoff. Ensure credentials permit `ahcc/<site>/drones/upsert`. |
| TAK bridge offline | Verify `TAK_*` envs, TLS files, and watch backend logs for `TAK_BRIDGE`. Use the **Restart Bridge** button after edits. |

---

## Legal

AntiHunter Command & Control PRO is an early-release security operations platform. It has not undergone formal penetration testing or certification for internet-facing use. Operate it on trusted networks, apply your own hardening, and comply with all local UAV/UAS regulations when monitoring airspace.

Licensing terms are provided in [LICENSE](LICENSE).

---

Happy hunting – and stay safe out there.


