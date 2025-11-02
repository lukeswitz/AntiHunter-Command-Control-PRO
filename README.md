<p align="center">
  <img src="TopREADMElogo.png" alt="AntiHunter Command Center Logo" width="320" />
</p>

# AntiHunter Command & Control Pro

AntiHunter Command & Control PRO is the companion operations platform for the AntiHunter SIGINT mesh network. Flash your AntiHunter detection nodes with the AntiHunter builds, then connect them here to orchestrate the entire perimeter defense mission. The Command Center ingests every heartbeat, target hit, triangulation update, and vibration alert from the mesh, renders nodes and geofences on a live map, automates scan/baseline/triangulation workflows, and drives alarm cues, exports, and audit trails.



> **Firmware note:** The companion firmware for mesh detection nodes lives in [lukeswitz/AntiHunter](https://github.com/lukeswitz/AntiHunter). Flash those builds to your field hardware before connecting them to this Command Center.



> **Early Release:** This is a beta build. Expect stability issues, breaking changes, and evolving features.



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

17. [Legal Disclaimer](#legal-disclaimer)



---



## Overview



AntiHunter Command & Control PRO turns raw radio/mesh telemetry into actionable situational awareness. The application keeps track of nodes, devices, and geofences, allows operators to launch complex detection sequences, and streams alerts through a tone-aware alarm engine. Everything is multi-site aware and backed by Prisma/PostgreSQL for durability.



## Feature Highlights



- **Real-time node tracking:** live map, trails/history, dynamic radius pulses, and geofence focus.

- **Detection workflows:** configurable scan presets, baseline collection, drone/deauth/randomization pipelines.

- **Command console:** parameterized command templates, audit logs, FOREVER protections, and command lifecycle tracking.

- **Alarms:** volume/rate limit per level, default tones, custom WAV uploads, do-not-disturb windows, and configurable color pulses on the map.

- **Inventory & targets:** ingestion of target data, vendor/OUI resolution, promotion to targets, triangulation capture, and exports.

- **Integrations:** TAK/CoT bridge with per-stream controls, MQTT federation, and SMTP hooks for alerting/administration.

- **Multi-site aware:** each site can have bespoke serial/MQTT configuration, coverage overrides, and admin assignments.

- **User management:** profile updates, admin console for user creation/role management, per-user preferences (theme, density, time format).

- **Geofence automation:** per-geofence alarms with enter/exit triggers, map focus highlights, and wizard-driven geometry authoring.

- **Operations controls:** API and UI actions to clear nodes, manage coverage, and import/export settings.



## UI Modules at a Glance



Each primary view ships with rich operator context. Replace the placeholder images below with real screenshots once the UI is finalized.



#### Map



Tracks live nodes, renders trails and geofences, and highlights alerts in real time.



![Map view showing live nodes and radius overlays](images/Map.png)



#### Console



Launch commands, manage templates, and review command acknowledgements/audits.



![Console view with command orchestration](images/Console.png)



#### Inventory



Review discovered devices, signal strength history, vendor resolutions, and export datasets.



![Inventory view listing detected devices](images/InventoryFilled.png)



#### Targets



Promote detections to tracked targets, view triangulation results, and manage status notes.



![Targets view with active detections](images/TargetsFilled.png)



#### Geofence



Create and edit geofences, tune alarm behavior, and jump to polygons on the map.



![Geofence management interface](images/GeoFenceFilled.png)



#### Nodes



Audit node health, connectivity, and telemetry history with quick map focus actions.



![Nodes list with health indicators](images/NodesFilled.png)



#### Scheduler



Plan recurring scans, FOREVER tasks, and automated detection sequences.



![Scheduler automation dashboard](images/Scheduler.png)



#### Config



Adjust system defaults (alarms, detection presets, serial ports, site federation) from a single pane.



![Configuration panel with system defaults](images/Config.png)



#### Exports



Generate CSV/GeoJSON bundles for inventory, targets, commands, and audit logs.



![Exports module with CSV and GeoJSON actions](images/Exports.png)



#### Account



Manage your profile, theme preferences, and admin-level user management tasks.



![Account preferences and admin tools](images/Account.png)



## Architecture



| Layer        | Technology                                              | Notes                                                              |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------------ |
| **Backend**  | NestJS, Prisma, Socket.IO                               | REST + WS APIs, serial ingest worker, command queue, alarm service |
| **Database** | PostgreSQL                                              | Prisma migrations, seeds for singleton config tables, audit trail  |
| **Frontend** | React (Vite), Zustand, React Query, Leaflet (map)       | SPA with map, targets, inventory, console, config modules          |
| **Tooling**  | pnpm workspace, TypeScript strict mode, ESLint/Prettier | developer experience, linting, formatting                          |



Data flows from serial workers -> Prisma (nodes/device tables) -> WS events -> Zustand stores -> React components. Commands and alarms run in the opposite direction, bubbling from the UI down to the serial layer.

### MQTT Topic Topology

Multi-site deployments share state through a single broker. All topics live under the `ahcc/` namespace and are segmented per site (`<siteId>` defaults to `default`). The current tree looks like this:

| Topic | Direction | Payload |
| --- | --- | --- |
| `ahcc/<siteId>/nodes/upsert` | publish + subscribe | Node snapshots (id, coords, last message metadata) emitted on heartbeats. |
| `ahcc/<siteId>/inventory/upsert` | publish + subscribe | Inventory device upserts (MAC, vendor, RSSI stats, last position). |
| `ahcc/<siteId>/targets/upsert` | publish + subscribe | Target lifecycle payloads (status, notes, tags, location, device metadata). |
| `ahcc/<siteId>/targets/delete` | publish + subscribe | `{ targetId }` payload notifying a target deletion. |
| `ahcc/<siteId>/commands/events` | publish + subscribe | Command lifecycle messages (`command.event`) so consoles stay aligned. |
| `ahcc/<siteId>/commands/request` | publish + subscribe | Remote command execution request for another site’s serial worker. |
| `ahcc/<siteId>/events/<type>` | publish + subscribe | High-value broadcasts (`event.alert`, `event.target`, `command.ack`, `command.result`). `<type>` is sanitized (slashes/dots -> dashes). |

All topics use QoS 1 by default (configurable per site). Publishers short-circuit when the `originSiteId` matches their own so messages are not looped. If additional replication streams are added, follow the `ahcc/<site>/<resource>/<action>` convention.

#### MQTT Configuration Cheat Sheet

Configure federation per site in **Config → MQTT** (or directly via the `MqttConfig` table). Key fields:

| Field | Purpose | Notes |
| --- | --- | --- |
| `brokerUrl` | Broker endpoint (`mqtt://`, `mqtts://`, `ws://`, or `wss://`) | Example: `mqtt://broker:1883`. WebSocket brokers often use `ws://host:port/mqtt`. |
| `clientId` | Unique MQTT client identifier | Defaults to `command-center-<siteId>`; must be unique on shared brokers. |
| `username` / `password` | Credentials for authenticated brokers | Leave blank for anonymous brokers. Combine with TLS settings when required. |
| `tlsEnabled`, `caPem`, `certPem`, `keyPem` | TLS configuration | Only needed for `mqtts://`/`wss://` brokers that require mutual TLS. PEM values are stored encrypted. |
| `qosEvents` / `qosCommands` | Default QoS for publish/subscribe (`0`, `1`, or `2`) | Defaults to `1`. Adjust when the broker or network profile demands otherwise. |
| `enabled` | Toggle federation for the site | Disable to keep a site local-only while preserving its saved connection details. |

**Environment defaults:**  
Set `SITE_ID` to the local site identifier (defaults to `default`). Each Command Center deployment **must use a unique `SITE_ID`** so MQTT replication distinguishes the origin site (e.g., `SITE_ID=alpha`, `SITE_ID=bravo`). Restart the backend after changing it. Optional flags like `MQTT_ENABLED`, `MQTT_COMMANDS_ENABLED`, and `MQTT_NAMESPACE` seed runtime config before any database records exist.

## Repository Layout



```
.
|- apps/
|  |- backend/           # NestJS app, Prisma schema, serial services
|  '- frontend/          # Vite SPA with React routes/stores
|- tools/
|  '- meshtastic-sniffer.ts  # standalone CLI to capture serial packets
|- pnpm-workspace.yaml
|- tsconfig.base.json
`- README.md
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



| Variable          | Description                                               |
| ----------------- | --------------------------------------------------------- |
| `JWT_SECRET`      | If auth is enabled later                                  |
| `SITE_ID`         | Default site for ingest                                   |
| `WS_MAX_CLIENTS`  | Socket.IO connection limit                                |
| `SERIAL_PROTOCOL` | Parser profile (`meshtastic-like`, `nmea-like`, etc.)     |
| `TAK_ENABLED`     | `true` to boot the TAK bridge automatically               |
| `TAK_PROTOCOL`    | TAK transport (`UDP`, `TCP`, or `HTTPS`)                  |
| `TAK_HOST`        | TAK core hostname or IP                                   |
| `TAK_PORT`        | Port that matches the TAK protocol (e.g., 6969/8088/8443) |
| `TAK_TLS`         | `true` when TLS certificates are required                 |
| `TAK_USERNAME`    | Optional basic-auth username for TAK gateways             |
| `TAK_PASSWORD`    | Optional basic-auth password (otherwise set via UI)       |
| `TAK_API_KEY`     | Optional API key for HTTPS-based TAK cores                |



Frontend currently consumes backend settings via API, so no extra `.env` is needed.



### TAK / Cursor-on-Target Bridge



The backend ships with a TAK bridge that translates node/alert telemetry into Cursor-on-Target events for ATAK/WinTAK ecosystems.



1. Apply the latest Prisma migrations (`pnpm --filter @command-center/backend prisma migrate deploy`) so the `TakConfig` table exists.

2. Set baseline values through environment variables (see table above) **or** configure them from the **Config -> TAK Bridge** card in the UI.

3. Choose the transport (`UDP` or `TCP` today; HTTPS/TLS fields are stored now for the upcoming TLS connector), then supply the host/port and any credentials.

4. Use the **Streams** and **Alert severities** toggles to decide which telemetry (nodes, targets, command ack/results, per-level alerts) is mirrored into TAK.

5. Click **Restart Bridge** after changes to force the connector to reconnect with the new settings.

6. When enabled, node positions and alert severities are pushed to the TAK core in real time; triangulation results and command acks appear as CoT notes.



> Passwords and API keys are write-only in the UI - enter new values when rotating credentials or use the **Clear Password** action.

>

> HTTPS/TLS support is staged. The configuration is persisted, but the connector currently establishes UDP or TCP sockets while the TLS transport lands.



**Stream controls (defaults):**



| Toggle                   | Default | CoT payload     | Notes                                                                    |
| ------------------------ | ------- | --------------- | ------------------------------------------------------------------------ |
| Node telemetry           | Yes      | `AHCC-NODE-*`   | Emits live node markers with last message metadata.                      |
| Target detections        | Yes      | `AHCC-TARGET-*` | Sends MAC detections/triangulation estimates (includes RSSI/confidence). |
| Command acknowledgements | No      | `AHCC-CMDACK-*` | Forward only if your TAK users need live command audit.                  |
| Command results          | No      | `AHCC-CMDRES-*` | Large payloads trimmed to 240 characters in CoT detail.                  |
| Alert: Info              | No      | `AHCC-ALERT-*`  | Keep off unless you need every heartbeat-level notification.             |
| Alert: Notice            | Yes      |                 | Targets promoted, triangulation updates, baselines.                      |
| Alert: Alert             | Yes      |                 | Vibration, deauth, drone detections.                                     |
| Alert: Critical          | Yes      |                 | ERASE, tamper, high-priority events.                                     |



All events are tagged under `<detail><ahcc*>...` blocks so TAK filters/overlays can key off `site`, `node`, `mac`, `status`, and more. Partial failures (e.g., TAK server offline) are logged with `TAK_BRIDGE drop (...)` lines in the backend output. If you see persistent drops, restart the bridge from the Config page after verifying connectivity.





## Database & Migrations



All Prisma migrations and seed scripts live in `apps/backend/prisma`. Run once after configuring Postgres:



```bash

cd apps/backend

pnpm prisma:generate

pnpm prisma:migrate

pnpm prisma:seed

```

> **Managed Postgres note:** The `pnpm prisma:migrate` script runs `prisma migrate deploy`, so it works with database roles that cannot create new databases. When authoring new migrations locally, use `pnpm prisma:migrate:dev` against a development instance that grants `CREATE DATABASE`.

Seed inserts singleton config rows (AppConfig, AlarmConfig, VisualConfig, CoverageConfig) plus a default site and admin user stub.



## Running the Stack



Open two terminals:



```bash

# Terminal 1 - backend API + WebSocket + serial worker

cd apps/backend

pnpm dev     # http://localhost:3000



# Terminal 2 - frontend SPA

cd apps/frontend

pnpm dev     # http://localhost:5173

```



Prefer a single command? From the repo root run `pnpm AHCC` to start both workspaces in parallel.



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



Compose auto-loads `.env` files adjacent to `docker-compose.yml`. To use the custom file above, launch with `docker compose --env-file docker/.env.local ...`. If you skip this step the defaults baked into `docker-compose.yml` are used (admin email `admin@example.com`, password `admin`).



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



| Variable         | Default             | Override                              |
| ---------------- | ------------------- | ------------------------------------- |
| `ADMIN_EMAIL`    | `admin@example.com` | set `ADMIN_EMAIL` in your env file    |
| `ADMIN_PASSWORD` | `admin`             | set `ADMIN_PASSWORD` in your env file |



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

    - '/dev/ttyUSB0:/dev/ttyUSB0'

  group_add:

    - dialout

  ```

  On macOS/Windows Docker Desktop, direct serial passthrough is not supported; run the backend natively or via WSL if hardware access is required.

- **Skipping migrations:** set `RUN_MIGRATIONS=false` if you manage schema deploys externally or if your database role cannot create shadow databases (then run `pnpm prisma:migrate` from a privileged environment).

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



### Meshtastic firmware configuration



When preparing a gateway node, open the Meshtastic device settings and enable **Override console serial port** so the mesh firmware exposes the command channel on the USB/serial interface used by the Command Center. The screenshot below shows the required toggle.



> **Note:** On the iOS and macOS Meshtastic apps this toggle may be missing. If you cannot enable it from the firmware UI, leave the device in its default state and specify the correct serial path/baud in the Command Center **Config -> Serial** card instead.



![Meshtastic override console serial settings](images/meshtasticsettings.png)



## Useful Scripts



| Command                                               | Description                      |
| ----------------------------------------------------- | -------------------------------- |
| `pnpm lint`                                           | ESLint across backend + frontend |
| `pnpm format`                                         | Prettier writes                  |
| `pnpm --filter @command-center/backend prisma:studio` | Inspect DB via Prisma Studio     |
| `pnpm --filter @command-center/backend prisma:seed`   | Reseed config rows               |
| `pnpm seed`                                           | Shortcut to seed default admin (requires pnpm on host) |

> **Docker note.** Production containers only install runtime dependencies, so the first time you seed from inside the backend container you must install the backend workspace dev deps and then run the seed:
> ```bash
> docker compose exec backend sh -lc "
>   cd /app &&
>   pnpm install --filter @command-center/backend --prod=false --ignore-scripts &&
>   pnpm --filter @command-center/backend prisma:seed
> "
> ```
> Subsequent reseeds can use the shorter command:
> ```bash
> docker compose exec backend sh -lc "cd /app && pnpm --filter @command-center/backend prisma:seed"
> ```
| `pnpm --filter @command-center/frontend preview`      | Preview SPA production build     |



## Operations & Maintenance



- **Clearing nodes:** The UI invokes `DELETE /nodes`, which now removes rows from `Node`, `NodePosition`, `NodeCoverageOverride`, and `TriangulationResult` tables in addition to clearing the in-memory cache. This prevents stale nodes from reappearing when new telemetry arrives.

- **Geofence focus:** Clicking **Focus** zooms/frames the polygon and highlights it for 10 seconds. No stale highlights remain thanks to background pruning.

- **Alarm profiles:** Uploading a new tone immediately swaps the preview audio; re-running the preview reflects custom volume settings.

- **Configuration cards:** Each card has expanded width (min 360px) so action buttons remain inside the panel even in dark mode.

- **TAK bridge:** The Config -> TAK Bridge card surfaces enablement, per-stream toggles (nodes, targets, command ack/results, alert severities), credentials, and the **Restart Bridge** action. Watch backend logs for lines prefixed with `TAK_BRIDGE` to confirm successful subscriptions or authentication failures.



## Troubleshooting



| Symptom                                             | Suggested Fix                                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend shows a blank page or 404 after deploy** | Ensure the SPA is served from the `/` root and that your reverse proxy rewrites unknown routes to `index.html`. In Docker, the bundled Nginx config already handles this.                                     |
| **Cannot log in with default credentials**          | Confirm the seed ran: the backend container logs should show "Running database migrations...". If you customized `ADMIN_EMAIL`/`ADMIN_PASSWORD`, restart the backend with the new env values.                   |
| **Backend returns `ECONNREFUSED` for Postgres**     | Check `docker compose logs postgres`; the DB must be healthy before the backend starts. If running locally, verify `DATABASE_URL` matches your Postgres host/port and that migrations were applied.           |
| **Serial device not detected**                      | On Windows note the `COM` port, on Linux grant access (`sudo usermod -aG dialout $USER` then re-login). Update the Config page or `.env` `SERIAL_DEVICE` with the correct path and restart the backend.       |
| **No alerts despite telemetry**                     | Confirm devices flashed with the companion firmware send events, sockets are connected (check `/healthz`), and that the alert filters on the terminal/alert drawer are not silencing the severity you expect. |
| **Custom alarm audio silent or too loud**           | After uploading a WAV file, adjust per-level volume sliders and click "Test". If volume does not change, refresh the page to reload cached audio. Supported formats: 16-bit PCM WAV.                          |
| **Docker push fails due to upstream changes**       | Run `git pull --rebase origin main` locally, resolve conflicts, then `git push`. This keeps your fork in sync before building new images.                                                                     |
| **Client notification: _Invalid Serial config…_**   | That toast is emitted by the Meshtastic radio itself. It appears when “Override console serial port” is enabled on the radio while it is running an interactive profile. Either disable the override in the Meshtastic firmware or switch the device to an output-only profile (NMEA/CalTopo).                                            |
| **MQTT connect timeout**                            | Ensure the backend is running (check `/healthz`) and that you’re using a reachable endpoint. Some public brokers require WebSockets (`ws://…`) instead of raw TCP (`mqtt://…`). Leave username/password blank when the broker is anonymous, and make sure “Enable site replication” is on before expecting events.                         |



---





## Legal Disclaimer

```

AntiHunter (AH) is provided for lawful, authorized use only-such as research, training, and security operations on systems and radio spectrum you own or have explicit written permission to assess. You are solely responsible for compliance with all applicable laws and policies, including privacy/data-protection (e.g., GDPR), radio/telecom regulations (LoRa ISM band limits, duty cycle), and export controls. Do not use AH to track, surveil, or target individuals, or to collect personal data without a valid legal basis and consent where required.



Authors and contributors are not liable for misuse, damages, or legal consequences arising from use of this project. By using AHCC, you accept full responsibility for your actions and agree to indemnify the authors and contributors against any claims related to your use. These tools are designed for ethical blue team use, such as securing events, auditing networks, or training exercises. To implement in code, ensure compliance with local laws (e.g., FCC regulations on transmissions) and pair with a directional antenna for enhanced accuracy.



THE SOFTWARE IN THIS REPOSITORY ("SOFTWARE") IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, OR RELIABILITY. TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL THE DEVELOPERS, MAINTAINERS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OR OTHER DEALINGS IN THE SOFTWARE, INCLUDING WITHOUT LIMITATION ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR LOSS OF DATA, PROFITS, GOODWILL, OR BUSINESS INTERRUPTION, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.



YOU ALONE ARE RESPONSIBLE FOR COMPLYING WITH ALL APPLICABLE LAWS, REGULATIONS, AND THIRD-PARTY RIGHTS. NO ADVICE OR INFORMATION, WHETHER ORAL OR WRITTEN, OBTAINED FROM THE PROJECT OR THROUGH THE SOFTWARE, CREATES ANY WARRANTY OR OBLIGATION NOT EXPRESSLY STATED HEREIN. IF APPLICABLE LAW DOES NOT ALLOW THE EXCLUSION OF CERTAIN WARRANTIES OR LIMITATION OF LIABILITY, THE DEVELOPERS', MAINTAINERS', AND CONTRIBUTORS' AGGREGATE LIABILITY SHALL NOT EXCEED THE GREATER OF: (A) THE AMOUNT YOU PAID (IF ANY) FOR THE COPY OF THE SOFTWARE THAT GAVE RISE TO THE CLAIM, OR (B) USD $0.



NOTWITHSTANDING ANYTHING TO THE CONTRARY, THE PROJECT MAINTAINERS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES ARISING FROM OR RELATED TO ANY THIRD-PARTY INTELLECTUAL PROPERTY CLAIMS, INCLUDING BUT NOT LIMITED TO ATTORNEYS' FEES, SETTLEMENT COSTS, OR INJUNCTIVE RELIEF.



BY USING THIS SOFTWARE, YOU ACKNOWLEDGE THE INHERENT RISKS ASSOCIATED WITH INTELLECTUAL PROPERTY COMPLIANCE AND ASSUME FULL RESPONSIBILITY FOR ENSURING YOUR USE COMPLIES WITH ALL APPLICABLE LAWS AND THIRD-PARTY RIGHTS.



