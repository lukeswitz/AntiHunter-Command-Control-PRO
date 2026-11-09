# Node → C2 integration plan

Closes the gaps in `INTEGRATION-GAPS.md`: make every node type's mesh output
render and persist in the Command Center, and let C2 reason about which node can
do what. Paths are relative to the repo root. `parser` =
`apps/backend/src/serial/protocols/meshtastic-rewrite.parser.ts`. `schema` =
`apps/backend/prisma/schema.prisma`.

The parser already classifies all node traffic into categories the UI consumes
(`radar`, `drone`, `sdr`, `lora`, `sentinel`, `triangulation`, …). The work is
not new parsing — it is persistence + rendering + a capability registry, so a
detection survives reload and C2 knows which node produced it.

## Track 1 — Node capability registry (prerequisite for the rest)

`Node` (schema:199) is an id + name + lastSeen + temperature. It has no band,
radio, or capability field, so C2 cannot gate radar-only or C5-only behavior or
label a detection by its source node's type.

- Add to `Node`: `nodeType String?` (`digi-2g4` | `digi-c5` | `radar` | `recon`),
  `bands String[]`, `capabilities String[]` (`wifi` | `ble` | `radar` |
  `sdr` | `rid` | `csi` | `lora`).
- Populate from the node's `startup` line (parser already emits category
  `startup`) — add the hardware/band fields to that frame in firmware, parse
  into the registry. Until firmware carries it, allow manual set via the Node
  edit UI.
- Everything downstream keys off this: map layers, per-node command gating, the
  node-picker the READMEs describe.

## Track 2 — Persist what is currently WebSocket-only (gap #5)

Sentinel/attack, CSI, probe, tamper, vibration arrive as `gateway.emitEvent`
WebSocket events with no Prisma model, so they vanish on reload.

- Add one `NodeEvent` model (ts, nodeId, category, subtype, payload Json,
  lat/lon?) rather than a model per detector — the categories already exist on
  the parsed event; store them uniformly and filter in the UI.
- Write on every parsed `alert`/detection event; the event console reads from it
  on load instead of only the live socket.

## Track 3 — Radar + Remote ID as first-class map detections (gaps #1, #2)

Both already parse; both lack a persisted row + map marker. `Drone` (schema:221)
is the pattern — it has lat/lon/rssi/operatorLat/operatorLon/status and renders
on the map.

- **RID (gap #2):** on `RID_RX`/`RID_CLAIM`, upsert a `Drone` row (not just an
  `alert`), reusing `FaaAircraft` (schema:776) for the registry lookup the Drone
  path already supports.
- **Radar (gap #1):** `DET` carries lat/lon. Add a `RadarContact` row mirroring
  `Drone`'s shape (ts, nodeId, lat/lon, strength, class) + a map layer toggle.
  `CAND` already lands in inventory + vendor — leave it.

## Track 4 — CSI + mesh-coordination consumers (gaps #3, #4)

- **CSI (gap #3):** `CSI_JSON_LEN`/`CSI_STATUS_LEN` parse as `command-result`
  with no reassembler. Add a fragment reassembler keyed by the length header,
  store the completed body on `NodeEvent` (track 2), render the
  channel-heatmap/waterfall the recon spec describes.
- **Mesh-coordination (gap #4):** `TOF_PING/PONG`, `BLOOM`, `IDHASH`,
  `CHAN_ASSIGN` emit as `mesh-coordination` alerts. Feed `TOF_*` into the
  existing `TriangulationResult` path; surface `CHAN_ASSIGN`/`IDHASH` on the
  fleet view (`FleetIdentity`/`FleetChannel` models exist).

## Track 5 — Auto-load OUI vendors

`OUI-list.csv` (38,514 rows) at repo root is not auto-imported; vendor columns
stay blank until a manual `POST /oui/import`
(`apps/backend/src/oui/oui.controller.ts`). Seed `OuiCache` (schema:528) from the
CSV on first boot when the table is empty, so Inventory/Targets/Baseline show
vendors without an operator step.

## Sequence

1. Track 1 (registry) — unblocks per-node labeling everywhere.
2. Track 5 (OUI auto-load) — one-file change, immediate UI value.
3. Track 2 (`NodeEvent` persistence) — stops reload data loss, backs tracks 3–4.
4. Track 3 (radar/RID map rows) — highest operator-visible payoff.
5. Track 4 (CSI/mesh consumers) — depends on tracks 1–2.

Each track is independent after track 1 and ships behind its own migration.
