import {
  SerialCommandAck,
  SerialNodeTelemetry,
  SerialParseResult,
  SerialProtocolParser,
  SerialAlertEvent,
} from '../serial.types';

const dynamicImport = new Function('specifier', 'return import(specifier);') as <TModule>(
  specifier: string,
) => Promise<TModule>;

type MeshProtoModule = typeof import('@meshtastic/protobufs');

let meshModulePromise: Promise<MeshProtoModule> | null = null;
let cachedMeshModule: MeshProtoModule | null = null;

export function ensureMeshtasticProtobufs(): Promise<MeshProtoModule> {
  if (!meshModulePromise) {
    meshModulePromise = dynamicImport<MeshProtoModule>('@meshtastic/protobufs').then((mod) => {
      cachedMeshModule = mod;
      return mod;
    });
  }
  return meshModulePromise;
}

function requireMeshModule(): MeshProtoModule {
  if (!cachedMeshModule) {
    throw new Error('Meshtastic protobuf module not loaded');
  }
  return cachedMeshModule;
}

type TriangulationBuffer = {
  lines: string[];
  startedAt: Date;
};

type PendingStatus = {
  nodeId: string;
  message: string;
  data: Record<string, unknown>;
  rawLines: string[];
  createdAt: number;
};

const TEXT_DECODER = new TextDecoder();
// eslint-disable-next-line no-control-regex, no-useless-escape -- requires matching ANSI escape sequences
const ANSI_STRIP_REGEX = /\u001B\[[0-9;]*[A-Za-z]/g;
const LOG_LINE_REGEX =
  /^(?<level>INFO|WARN|ERROR|DEBUG|TRACE)\s*\|\s*(?<timestamp>[^[]+?)\s*\[(?<source>[^]]+)\]\s*(?<message>.+)$/i;
const ROUTER_QUEUE_FULL_REGEX = /ToPhone queue is full/i;
const ROUTER_DROP_PACKET_REGEX = /drop packet/i;
const ROUTER_BUSY_RX_REGEX = /busyRx/i;
const TARGET_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*Target:\s*(?<type>[A-Za-z0-9_-]+)\s*(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s*RSSI:(?<rssi>-?\d+)\s*(?:Name:(?<name>[^[]+?))?(?:\s*GPS[=:](?<lat>-?\d+\.\d+),\s*(?<lon>-?\d+\.\d+))?/i;
const TARGET_DATA_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*TARGET_DATA:\s*(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+Hits=(?<hits>\d+)\s+RSSI:(?<rssi>-?\d+)(?:\s+Type:(?<type>\w+))?(?:\s+GPS[=:](?<lat>-?\d+\.\d+),\s*(?<lon>-?\d+\.\d+))?(?:\s+HDOP=(?<hdop>\d+\.\d+))?/i;
const VIBRATION_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*VIBRATION:\s*Movement(?:\s+detected)?\s+at\s*(?<time>\d{2}:\d{2}:\d{2})(?:\s*GPS[=:](?<lat>-?\d+\.\d+),\s*(?<lon>-?\d+\.\d+))?/i;
const DEVICE_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*DEVICE:(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})(?:\s+(?<band>[A-Za-z0-9]+))?\s+(?<rssi>-?\d+)(?:\s+(?<extras>.*))?$/i;
const GPS_STATUS_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*GPS:\s*(?<status>[A-Z]+)\s*Location[=:](?<lat>-?\d+(?:\.\d+)?)\s*,\s*(?<lon>-?\d+(?:\.\d+)?)\s*Satellites[=:](?<sats>\d+)\s*HDOP[=:](?<hdop>\d+(?:\.\d+)?)/i;
const GPS_SIMPLE_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*GPS(?:[:=]\s*|\s+)(?<lat>-?\d+(?:\.\d+)?)\s*,\s*(?<lon>-?\d+(?:\.\d+)?)/i;
const NODE_HEARTBEAT_REGEX =
  /^\[NODE_HB\]\s*(?<node>[A-Za-z0-9_-]+).*?GPS[=:](?<lat>-?\d+\.\d+),\s*(?<lon>-?\d+\.\d+)/i;
const STATUS_REGEX =
  /^(?<node>[A-Za-z0-9_-]+)\s*:?\s*STATUS:\s*Mode:(?<mode>[A-Za-z0-9+]+)\s+Scan:(?<scan>[A-Za-z]+)\s+Hits:(?<hits>\d+)\s+Unique:(?<unique>\d+)\s+Temp:\s*(?<tempC>[0-9.]+).?C\s*\/\s*(?<tempF>[0-9.]+).?F\s+Up:(?<uptime>[0-9:]+)(?:\s+Targets:(?<targets>\d+))?(?:\s+GPS[:=](?<gpsLat>-?\d+(?:\.\d+)?),\s*(?<gpsLon>-?\d+(?:\.\d+)?))?/i;
const CONFIG_ACK_REGEX = /^(?<node>[A-Za-z0-9_-]+):\s*CONFIG_ACK:(?<type>[A-Z_]+):(?<value>.+)$/i;

const OP_ACK_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*(?<kind>SCAN|DEVICE_SCAN|DRONE|DEAUTH|RANDOMIZATION|BASELINE)_ACK:(?<status>[A-Z_]+)/i;
const TRI_ACK_REGEX = /^(?<node>[A-Za-z0-9_-]+):\s*TRIANGULATE_ACK:(?<target>.+)$/i;
const TRI_STOP_ACK_REGEX = /^(?<node>[A-Za-z0-9_-]+):\s*TRIANGULATE_STOP_ACK\b/i;
const TRI_RESULTS_START_REGEX = /^(?<node>[A-Za-z0-9_-]+):\s*TRIANGULATE_RESULTS_START\b/i;
const TRI_RESULTS_END_REGEX = /^(?<node>[A-Za-z0-9_-]+):\s*TRIANGULATE_RESULTS_END\b/i;
const BASELINE_STATUS_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*BASELINE_STATUS:\s*Scanning:(?<scanning>YES|NO)\s*Established:(?<est>YES|NO)\s*Devices[=:](?<devices>\d+)\s*Anomalies[=:](?<anomalies>\d+)\s*Phase1:(?<phase>ACTIVE|COMPLETE)/i;
const ERASE_ACK_REGEX =
  /^(?<node>[A-Za-z0-9_-]+):\s*ERASE_ACK:(?<status>STARTED|COMPLETE|CANCELLED|FAILED)/i;
const SCAN_DONE_REGEX = /^(?<node>[A-Za-z0-9_-]+)\s+SCAN_DONE:\s*(?<details>.+)$/i;
const STARTUP_REGEX = /^(?<node>[A-Za-z0-9_-]+):\s*STARTUP:\s*(?<details>.+)$/i;
const OK_STATUS_REGEX = /^(?<node>[A-Za-z0-9_-]+)\s+OK\s+Status:(?<status>[A-Z]+)#?$/i;
const GENERIC_NODE_LINE_REGEX =
  /^(?:\[(?<tag>[A-Z_]+)\]\s*)?(?<node>[A-Za-z0-9_-]+):\s*(?<body>.+)$/i;
const FORWARDED_PREFIX_REGEX = /^(?<prefix>[0-9a-f]{2,8}):\s+(?<rest>.+)$/i;
const ROUTER_TEXT_MSG_REGEX = /\[Router\]\s+Received text msg.*?msg=(#?[\s\S]+)$/i;
const STATUS_DEDUP_MS = 60_000;
export class MeshtasticLikeParser implements SerialProtocolParser {
  private readonly triangulationBuffers: Map<string, TriangulationBuffer>;
  private readonly pendingStatuses: Map<string, PendingStatus>;
  private readonly statusCache: Map<string, { message: string; timestamp: number }>;
  private readonly recentGpsEvents: Map<string, { lat: number; lon: number; timestamp: number }>;
  private readonly recentVibrationEvents: Map<string, { hash: string; timestamp: number }>;
  private static readonly PENDING_STATUS_TTL_MS = 1500;
  private static readonly GPS_DUPLICATE_WINDOW_MS = 7000;
  private static readonly VIBRATION_DUPLICATE_WINDOW_MS = 7000;

  constructor() {
    this.triangulationBuffers = new Map();
    this.pendingStatuses = new Map();
    this.statusCache = new Map();
    this.recentGpsEvents = new Map();
    this.recentVibrationEvents = new Map();
  }
  parseLine(line: string): SerialParseResult[] {
    const stripped = stripAnsi(line ?? '');
    const trimmed = stripped.trim();
    if (!trimmed) {
      return [];
    }
    if (looksBinary(trimmed)) {
      return this.parseBinary(trimmed);
    }
    const textResults = this.parseText(trimmed);
    if (textResults) {
      return textResults;
    }
    return [{ kind: 'raw', raw: trimmed }];
  }
  reset(): void {
    this.triangulationBuffers.clear();
    this.pendingStatuses.clear();
    this.statusCache.clear();
    this.recentGpsEvents.clear();
    this.recentVibrationEvents.clear();
  }
  private parseBinary(raw: string): SerialParseResult[] {
    const { Mesh, Portnums, Telemetry } = requireMeshModule();
    const events: SerialParseResult[] = [];
    type MeshPacket = ReturnType<typeof Mesh.MeshPacketSchema.fromBinary>;
    let packet: MeshPacket | undefined;
    try {
      packet = Mesh.MeshPacketSchema.fromBinary(Buffer.from(raw, 'binary'));
    } catch {
      return [{ kind: 'raw', raw }];
    }
    if (!packet?.decoded) {
      return [{ kind: 'raw', raw }];
    }
    const decoded = packet.decoded;
    const nodeId = this.normalizeNodeId(packet.from ?? '');
    if (decoded.portnum === Portnums.PortNum.LOCATION_APP && decoded.payload) {
      try {
        const position = Telemetry.PositionSchema.fromBinary(decoded.payload);
        if (position.latitudeI != null && position.longitudeI != null) {
          events.push(
            this.toTelemetry(
              nodeId,
              position.latitudeI / 1e7,
              position.longitudeI / 1e7,
              raw,
              position.time ? new Date(position.time * 1000).toISOString() : undefined,
            ),
          );
          return events;
        }
      } catch {
        // ignore and continue with fallback parsing
      }
    }
    if (decoded.portnum === Portnums.PortNum.TELEMETRY_APP && decoded.payload) {
      try {
        const telemetry = Telemetry.TelemetrySchema.fromBinary(decoded.payload);
        events.push({
          kind: 'alert',
          level: 'INFO',
          category: 'telemetry',
          nodeId,
          message: `${nodeId} telemetry update`,
          data: telemetry,
          raw,
        });
        return events;
      } catch {
        // ignore and continue with fallback parsing
      }
    }
    if (decoded.payload) {
      const text = safeDecodeText(decoded.payload);
      if (text) {
        const forwardedResults = this.parseText(text);
        if (forwardedResults) {
          return forwardedResults.map((event) => ({ ...event, raw }));
        }
        events.push({
          kind: 'alert',
          level: 'INFO',
          category: 'text',
          nodeId,
          message: text,
          raw,
        });
        return events;
      }
    }
    return [{ kind: 'raw', raw }];
  }
  private parseText(line: string): SerialParseResult[] | null {
    const results: SerialParseResult[] = [];
    let handled = false;

    // Normalize router forwarded text frames (credit: @lukeswitz)
    const routerMatch = ROUTER_TEXT_MSG_REGEX.exec(line);
    if (routerMatch?.[1]) {
      const embeddedMsg = routerMatch[1].trim().replace(/#$/, '');
      const embeddedResults = this.parseText(embeddedMsg);
      if (embeddedResults && embeddedResults.length > 0) {
        return embeddedResults.map((event) => ({ ...event, raw: line }));
      }

      const genericMatch = GENERIC_NODE_LINE_REGEX.exec(embeddedMsg);
      if (genericMatch?.groups) {
        const normalizedNode = this.normalizeNodeId(genericMatch.groups.node);
        const message = `[${genericMatch.groups.node}] ${genericMatch.groups.body}`;
        return [
          {
            kind: 'alert',
            level: 'INFO',
            category: 'text',
            nodeId: normalizedNode,
            message,
            raw: line,
          },
        ];
      }

      return [
        {
          kind: 'alert',
          level: 'INFO',
          category: 'text',
          message: embeddedMsg,
          raw: line,
        },
      ];
    }

    this.flushExpiredStatuses(results);
    if (isLogLine(line)) {
      const log = parseLogLine(line);
      if (log) {
        const source = log.source?.toUpperCase() ?? '';
        if (source === 'ROUTER' || ROUTER_BUSY_RX_REGEX.test(log.message)) {
          return [{ kind: 'raw', raw: line }];
        }
        const alert = this.buildLogAlert(log, line);
        if (alert) {
          return this.deliverOrRaw([alert], line);
        }
      }
      return [];
    }
    const forwardedMatch = FORWARDED_PREFIX_REGEX.exec(line);
    if (forwardedMatch?.groups) {
      const forwardedLine = forwardedMatch.groups.rest.trim();
      const forwardedResults = this.parseText(forwardedLine);
      if (forwardedResults) {
        return forwardedResults.map((event) => ({ ...event, raw: line }));
      }
    }
    const targetMatch = TARGET_REGEX.exec(line);
    if (targetMatch?.groups) {
      const nodeId = this.normalizeNodeId(targetMatch.groups.node);
      const mac = normalizeMac(targetMatch.groups.mac);
      const rssi = toNumber(targetMatch.groups.rssi);
      const lat = toNumber(targetMatch.groups.lat);
      const lon = toNumber(targetMatch.groups.lon);
      results.push({
        kind: 'target-detected',
        nodeId,
        mac,
        rssi,
        type: targetMatch.groups.type,
        name: targetMatch.groups.name?.trim(),
        channel: extractChannelFromText(line),
        lat,
        lon,
        raw: line,
      });
      return this.deliverOrRaw(results, line);
    }
    const targetDataMatch = TARGET_DATA_REGEX.exec(line);
    if (targetDataMatch?.groups) {
      const nodeId = this.normalizeNodeId(targetDataMatch.groups.node);
      const mac = normalizeMac(targetDataMatch.groups.mac);
      const rssi = toNumber(targetDataMatch.groups.rssi);
      const lat = toNumber(targetDataMatch.groups.lat);
      const lon = toNumber(targetDataMatch.groups.lon);
      results.push({
        kind: 'target-detected',
        nodeId,
        mac,
        rssi,
        type: targetDataMatch.groups.type ?? undefined,
        channel: extractChannelFromText(line),
        lat,
        lon,
        raw: line,
      });
      if (lat != null && lon != null) {
        results.push(this.toTelemetry(nodeId, lat, lon, line, 'Target report position'));
      }
      return this.deliverOrRaw(results, line);
    }
    const vibrationMatch = VIBRATION_REGEX.exec(line);
    if (vibrationMatch?.groups) {
      const nodeId = this.normalizeNodeId(vibrationMatch.groups.node);
      const lat = toNumber(vibrationMatch.groups.lat);
      const lon = toNumber(vibrationMatch.groups.lon);
      if (this.isDuplicateVibration(nodeId, line)) {
        return [];
      }
      this.recordVibration(nodeId, line);
      const alertData: Record<string, unknown> = { time: vibrationMatch.groups.time };
      if (lat != null && lon != null) {
        alertData.lat = lat;
        alertData.lon = lon;
      }
      results.push({
        kind: 'alert',
        level: 'CRITICAL',
        category: 'vibration',
        nodeId,
        message: `${nodeId} VIBRATION ${vibrationMatch.groups.time}`,
        data: alertData,
        raw: line,
      });
      return this.deliverOrRaw(results, line);
    }
    const deviceMatch = DEVICE_REGEX.exec(line);
    if (deviceMatch?.groups) {
      const nodeId = this.normalizeNodeId(deviceMatch.groups.node);
      const mac = normalizeMac(deviceMatch.groups.mac);
      const rssi = toNumber(deviceMatch.groups.rssi);
      const band = deviceMatch.groups.band ? resolveDeviceType(deviceMatch.groups.band) : undefined;
      const extras = deviceMatch.groups.extras ?? '';

      let name: string | undefined;
      const nameMatch = /N:([^#]+)/i.exec(extras);
      if (nameMatch?.[1]) {
        name = nameMatch[1].trim();
      }

      results.push({
        kind: 'target-detected',
        nodeId,
        mac,
        rssi,
        type: band,
        name,
        channel: extractChannelFromText(extras),
        raw: line,
      });
      return this.deliverOrRaw(results, line);
    }
    const gpsStatusMatch = GPS_STATUS_REGEX.exec(line);
    if (gpsStatusMatch?.groups) {
      const nodeId = this.normalizeNodeId(gpsStatusMatch.groups.node);
      const lat = toNumber(gpsStatusMatch.groups.lat);
      const lon = toNumber(gpsStatusMatch.groups.lon);
      if (lat != null && lon != null) {
        results.push(this.toTelemetry(nodeId, lat, lon, line, 'GPS status'));
      }
      const coordinateSummary =
        lat != null && lon != null
          ? `${formatCoordinate(lat, true)}, ${formatCoordinate(lon, false)}`
          : undefined;
      const messageParts = [`${nodeId} GPS ${gpsStatusMatch.groups.status}`];
      if (coordinateSummary) {
        messageParts.push(coordinateSummary);
      }
      results.push({
        kind: 'alert',
        level: 'NOTICE',
        category: 'gps',
        nodeId,
        message: messageParts.join(' '),
        data: {
          satellites: toNumber(gpsStatusMatch.groups.sats),
          hdop: toNumber(gpsStatusMatch.groups.hdop),
          lat,
          lon,
          formattedLat: lat != null ? formatCoordinate(lat, true) : undefined,
          formattedLon: lon != null ? formatCoordinate(lon, false) : undefined,
        },
        raw: line,
      });
      return this.deliverOrRaw(results, line);
    }
    const gpsSimpleMatch = GPS_SIMPLE_REGEX.exec(line);
    if (gpsSimpleMatch?.groups) {
      const nodeId = this.normalizeNodeId(gpsSimpleMatch.groups.node);
      const lat = toNumber(gpsSimpleMatch.groups.lat);
      const lon = toNumber(gpsSimpleMatch.groups.lon);
      if (lat != null && lon != null) {
        if (this.isDuplicateGps(nodeId, lat, lon)) {
          return [];
        }
        this.recordGps(nodeId, lat, lon);
        const formattedLat = formatCoordinate(lat, true);
        const formattedLon = formatCoordinate(lon, false);
        results.push(this.toTelemetry(nodeId, lat, lon, line, 'GPS update'));
        const pending = this.pendingStatuses.get(nodeId);
        if (pending) {
          results.push(
            this.buildStatusAlert(pending, {
              lat,
              lon,
              formattedLat,
              formattedLon,
              additionalRaw: [line],
            }),
          );
          this.pendingStatuses.delete(nodeId);
        }
        return this.deliverOrRaw(results, line);
      }
    }
    const heartbeatMatch = NODE_HEARTBEAT_REGEX.exec(line);
    if (heartbeatMatch?.groups) {
      const nodeId = this.normalizeNodeId(heartbeatMatch.groups.node);
      const lat = toNumber(heartbeatMatch.groups.lat) ?? 0;
      const lon = toNumber(heartbeatMatch.groups.lon) ?? 0;
      results.push(this.toTelemetry(nodeId, lat, lon, line, 'Heartbeat'));
      return this.deliverOrRaw(results, line);
    }
    const statusMatch = STATUS_REGEX.exec(line);
    if (statusMatch?.groups) {
      const nodeId = this.normalizeNodeId(statusMatch.groups.node);
      const existing = this.pendingStatuses.get(nodeId);
      if (existing) {
        results.push(this.buildStatusAlert(existing));
        this.pendingStatuses.delete(nodeId);
      }
      let message = `${nodeId} Status Mode:${statusMatch.groups.mode} Scan:${statusMatch.groups.scan} Hits:${statusMatch.groups.hits} Unique:${statusMatch.groups.unique} Temp:${statusMatch.groups.tempC}C/${statusMatch.groups.tempF}F Up:${statusMatch.groups.uptime}`;
      if (statusMatch.groups.targets) {
        message += ` Targets:${statusMatch.groups.targets}`;
      }
      const data: Record<string, unknown> = {
        hits: toNumber(statusMatch.groups.hits),
        unique: toNumber(statusMatch.groups.unique),
        tempC: toNumber(statusMatch.groups.tempC),
        tempF: toNumber(statusMatch.groups.tempF),
        uptime: statusMatch.groups.uptime,
      };
      if (statusMatch.groups.mode) {
        data.mode = statusMatch.groups.mode;
      }
      if (statusMatch.groups.scan) {
        data.scan = statusMatch.groups.scan;
      }
      if (statusMatch.groups.targets) {
        data.targets = toNumber(statusMatch.groups.targets);
      }
      const lat = toNumber(statusMatch.groups.gpsLat);
      const lon = toNumber(statusMatch.groups.gpsLon);
      const hasInlineGps = lat != null && lon != null;
      const pendingStatus: PendingStatus = {
        nodeId,
        message,
        data,
        rawLines: [line],
        createdAt: Date.now(),
      };
      if (hasInlineGps) {
        const formattedLat = formatCoordinate(lat, true);
        const formattedLon = formatCoordinate(lon, false);
        if (!this.isDuplicateGps(nodeId, lat, lon)) {
          this.recordGps(nodeId, lat, lon);
          results.push(this.toTelemetry(nodeId, lat, lon, line, 'Status GPS'));
        }
        results.push(
          this.buildStatusAlert(pendingStatus, {
            lat,
            lon,
            formattedLat,
            formattedLon,
          }),
        );
        return this.deliverOrRaw(results, line);
      }
      this.pendingStatuses.set(nodeId, pendingStatus);
      return this.deliverOrRaw(results, line);
    }
    const scanDoneMatch = SCAN_DONE_REGEX.exec(line);
    if (scanDoneMatch?.groups) {
      const nodeId = this.normalizeNodeId(scanDoneMatch.groups.node);
      const payload = scanDoneMatch.groups.details.trim().replace(/#$/, '');
      results.push({
        kind: 'command-result',
        nodeId,
        command: 'SCAN_DONE',
        payload,
        raw: line,
      });
      return this.deliverOrRaw(results, line);
    }
    const ackMatch = OP_ACK_REGEX.exec(line);
    if (ackMatch?.groups) {
      const nodeId = this.normalizeNodeId(ackMatch.groups.node);
      results.push(
        this.buildAckEvent(nodeId, `${ackMatch.groups.kind}_ACK`, ackMatch.groups.status, line),
      );
      return this.deliverOrRaw(results, line);
    }
    const configAckMatch = CONFIG_ACK_REGEX.exec(line);
    if (configAckMatch?.groups) {
      const nodeId = this.normalizeNodeId(configAckMatch.groups.node);
      results.push(this.buildAckEvent(nodeId, `CONFIG_${configAckMatch.groups.type}`, 'OK', line));
      return this.deliverOrRaw(results, line);
    }
    const triAckMatch = TRI_ACK_REGEX.exec(line);
    if (triAckMatch?.groups) {
      const nodeId = this.normalizeNodeId(triAckMatch.groups.node);
      results.push(this.buildAckEvent(nodeId, 'TRIANGULATE_ACK', triAckMatch.groups.target, line));
      return this.deliverOrRaw(results, line);
    }
    if (TRI_STOP_ACK_REGEX.test(line)) {
      const match = TRI_STOP_ACK_REGEX.exec(line);
      if (match?.groups) {
        const nodeId = this.normalizeNodeId(match.groups.node);
        results.push(this.buildAckEvent(nodeId, 'TRIANGULATE_STOP_ACK', 'OK', line));
        return this.deliverOrRaw(results, line);
      }
    }
    if (TRI_RESULTS_START_REGEX.test(line)) {
      const match = TRI_RESULTS_START_REGEX.exec(line);
      if (match?.groups) {
        const nodeId = this.normalizeNodeId(match.groups.node);
        this.triangulationBuffers.set(nodeId, { lines: [], startedAt: new Date() });
        handled = true;
        return [];
      }
    }
    if (TRI_RESULTS_END_REGEX.test(line)) {
      const match = TRI_RESULTS_END_REGEX.exec(line);
      if (match?.groups) {
        const nodeId = this.normalizeNodeId(match.groups.node);
        const buffer = this.triangulationBuffers.get(nodeId);
        if (buffer) {
          this.triangulationBuffers.delete(nodeId);
          results.push({
            kind: 'alert',
            level: 'NOTICE',
            category: 'triangulate',
            nodeId,
            message: `${nodeId} TRIANGULATE results`,
            data: { lines: buffer.lines },
            raw: line,
          });
          return this.deliverOrRaw(results, line);
        }
      }
    }
    const baselineMatch = BASELINE_STATUS_REGEX.exec(line);
    if (baselineMatch?.groups) {
      const nodeId = this.normalizeNodeId(baselineMatch.groups.node);
      results.push({
        kind: 'alert',
        level: 'INFO',
        category: 'baseline',
        nodeId,
        message: `${nodeId} Baseline Scanning:${baselineMatch.groups.scanning} Established:${baselineMatch.groups.est}`,
        data: {
          devices: toNumber(baselineMatch.groups.devices),
          anomalies: toNumber(baselineMatch.groups.anomalies),
          phase: baselineMatch.groups.phase,
        },
        raw: line,
      });
      return this.deliverOrRaw(results, line);
    }
    const startupMatch = STARTUP_REGEX.exec(line);
    if (startupMatch?.groups) {
      const nodeId = this.normalizeNodeId(startupMatch.groups.node);
      const detailText = restoreHumanReadableUnits(startupMatch.groups.details).replace(
        /\s+#?$/,
        '',
      );
      const message = `${nodeId} startup: ${detailText}`;
      if (!this.shouldDeduplicateStatus(nodeId, message)) {
        results.push({
          kind: 'alert',
          level: 'NOTICE',
          category: 'status',
          nodeId,
          message,
          raw: line,
        });
      }
      return this.deliverOrRaw(results, line);
    }
    const okStatusMatch = OK_STATUS_REGEX.exec(line);
    if (okStatusMatch?.groups) {
      const nodeId = this.normalizeNodeId(okStatusMatch.groups.node);
      const status = okStatusMatch.groups.status;
      const message = `${nodeId} status: ${status}`;
      if (!this.shouldDeduplicateStatus(nodeId, message)) {
        results.push({
          kind: 'alert',
          level: 'NOTICE',
          category: 'status',
          nodeId,
          message,
          raw: line.replace(/#$/, ''),
        });
      }
      return this.deliverOrRaw(results, line);
    }
    const eraseMatch = ERASE_ACK_REGEX.exec(line);
    if (eraseMatch?.groups) {
      const nodeId = this.normalizeNodeId(eraseMatch.groups.node);
      results.push(this.buildAckEvent(nodeId, 'ERASE_ACK', eraseMatch.groups.status, line));
      results.push({
        kind: 'alert',
        level: 'CRITICAL',
        category: 'erase',
        nodeId,
        message: `Erase ${eraseMatch.groups.status}`,
        raw: line,
      });
      return this.deliverOrRaw(results, line);
    }
    const genericMatch = GENERIC_NODE_LINE_REGEX.exec(line);
    if (genericMatch?.groups) {
      const nodeId = this.normalizeNodeId(genericMatch.groups.node);
      const buffer = this.triangulationBuffers.get(nodeId);
      if (buffer) {
        buffer.lines.push(genericMatch.groups.body.trim());
        handled = true;
        return [];
      }
      const body = restoreHumanReadableUnits(genericMatch.groups.body.trim());
      if (/^GPS[:=\s]/i.test(body) && /^GPS[:=\s]*-?\d+(?:\.\d+)?\s*,\s*$/i.test(body)) {
        handled = true;
        return [];
      }
      results.push({
        kind: 'alert',
        level: 'INFO',
        category: 'console',
        nodeId,
        message: `${nodeId} ${body}`,
        raw: line,
      });
      return this.deliverOrRaw(results, line);
    }
    return handled ? [] : null;
  }
  private flushExpiredStatuses(results: SerialParseResult[]): void {
    const now = Date.now();
    for (const [nodeId, pending] of Array.from(this.pendingStatuses.entries())) {
      if (now - pending.createdAt >= MeshtasticLikeParser.PENDING_STATUS_TTL_MS) {
        results.push(this.buildStatusAlert(pending));
        this.pendingStatuses.delete(nodeId);
      }
    }
  }
  private shouldDeduplicateStatus(nodeId: string, message: string): boolean {
    const now = Date.now();
    const cacheEntry = this.statusCache.get(nodeId);
    if (
      cacheEntry &&
      cacheEntry.message === message &&
      now - cacheEntry.timestamp < STATUS_DEDUP_MS
    ) {
      return true;
    }
    this.statusCache.set(nodeId, { message, timestamp: now });
    return false;
  }
  private buildStatusAlert(
    pending: PendingStatus,
    extras?: {
      lat?: number;
      lon?: number;
      formattedLat?: string;
      formattedLon?: string;
      additionalRaw?: string[];
    },
  ): SerialParseResult {
    const formattedLat = extras?.formattedLat;
    const formattedLon = extras?.formattedLon;
    const lat = extras?.lat;
    const lon = extras?.lon;
    let message = pending.message;
    if (formattedLat && formattedLon) {
      message = `${message}\n${pending.nodeId} GPS ${formattedLat}, ${formattedLon}`;
    }
    const data: Record<string, unknown> = { ...pending.data };
    if (lat != null) {
      data.lat = lat;
    }
    if (lon != null) {
      data.lon = lon;
    }
    if (formattedLat) {
      data.formattedLat = formattedLat;
    }
    if (formattedLon) {
      data.formattedLon = formattedLon;
    }
    const rawParts = [...pending.rawLines];
    if (extras?.additionalRaw) {
      rawParts.push(...extras.additionalRaw);
    }
    return {
      kind: 'alert',
      level: 'NOTICE',
      category: 'status',
      nodeId: pending.nodeId,
      message,
      data,
      raw: rawParts.join('\n'),
    };
  }
  private buildLogAlert(log: ParsedLogLine, raw: string): SerialAlertEvent | null {
    if (ROUTER_QUEUE_FULL_REGEX.test(log.message) || ROUTER_DROP_PACKET_REGEX.test(log.message)) {
      const level = log.level === 'ERROR' ? 'ALERT' : 'NOTICE';
      return {
        kind: 'alert',
        level,
        category: 'router-warning',
        message: `[${log.source ?? 'Device'}] ${log.message}`,
        data: {
          level: log.level,
          source: log.source,
          timestamp: log.timestamp,
        },
        raw,
      };
    }
    return null;
  }
  private isDuplicateGps(nodeId: string, lat: number, lon: number): boolean {
    const previous = this.recentGpsEvents.get(nodeId);
    if (!previous) {
      return false;
    }
    const isSameLat = Math.abs(previous.lat - lat) < 1e-6;
    const isSameLon = Math.abs(previous.lon - lon) < 1e-6;
    if (!isSameLat || !isSameLon) {
      return false;
    }
    return Date.now() - previous.timestamp < MeshtasticLikeParser.GPS_DUPLICATE_WINDOW_MS;
  }
  private recordGps(nodeId: string, lat: number, lon: number): void {
    this.recentGpsEvents.set(nodeId, { lat, lon, timestamp: Date.now() });
  }
  private isDuplicateVibration(nodeId: string, raw: string): boolean {
    const previous = this.recentVibrationEvents.get(nodeId);
    if (!previous) {
      return false;
    }
    if (previous.hash !== raw.trim()) {
      return false;
    }
    return Date.now() - previous.timestamp < MeshtasticLikeParser.VIBRATION_DUPLICATE_WINDOW_MS;
  }
  private recordVibration(nodeId: string, raw: string): void {
    this.recentVibrationEvents.set(nodeId, { hash: raw.trim(), timestamp: Date.now() });
  }
  private deliverOrRaw(results: SerialParseResult[], line: string): SerialParseResult[] {
    if (!results.length) {
      return results;
    }
    if (this.shouldDeliverToTerminal(results, line)) {
      return results;
    }
    return results;
  }
  private shouldDeliverToTerminal(results: SerialParseResult[], line: string): boolean {
    if (/AH/i.test(line)) {
      return true;
    }
    for (const result of results) {
      const candidate = (result as { nodeId?: string }).nodeId;
      if (candidate && candidate.toUpperCase().includes('NODE_AH')) {
        return true;
      }
      if (result.kind === 'target-detected') {
        const raw = (result as { raw?: string }).raw;
        if (raw && /AH/i.test(raw)) {
          return true;
        }
      }
    }
    return false;
  }
  private toTelemetry(
    nodeId: string,
    lat: number,
    lon: number,
    raw: string,
    lastMessage?: string,
  ): SerialNodeTelemetry {
    return {
      kind: 'node-telemetry',
      nodeId,
      lat,
      lon,
      timestamp: new Date(),
      lastMessage,
      raw,
    };
  }
  private buildAckEvent(
    nodeId: string,
    ackType: string,
    status: string,
    raw: string,
  ): SerialCommandAck {
    return {
      kind: 'command-ack',
      nodeId,
      ackType: ackType.toUpperCase(),
      status: status.trim(),
      raw,
    };
  }
  private normalizeNodeId(value: string): string {
    if (!value) {
      return 'NODE_UNKNOWN';
    }
    const trimmed = value.trim();
    const segments = trimmed
      .split(':')
      .map((segment) => segment.trim())
      .filter(Boolean);
    const token = segments.length > 0 ? segments[segments.length - 1] : trimmed;
    if (!token) {
      return 'NODE_UNKNOWN';
    }
    const upper = token.toUpperCase();
    if (/^NODE[\s_-]/i.test(token)) {
      const base = upper.replace(/^NODE[\s_-]?/, '');
      const normalized = base.replace(/[^A-Z0-9]/g, '');
      return normalized ? `NODE_${normalized}` : 'NODE_UNKNOWN';
    }
    if (/^NODE_/i.test(token)) {
      return upper.replace(/[^A-Z0-9_]/g, '');
    }
    if (/^NODE-/i.test(token)) {
      return `NODE_${upper.replace(/^NODE-/, '').replace(/[^A-Z0-9]/g, '')}`;
    }
    if (/^NODE[0-9A-Z]/i.test(token)) {
      const normalized = upper.replace(/^NODE/, '').replace(/[^A-Z0-9]/g, '');
      return normalized ? `NODE_${normalized}` : 'NODE_UNKNOWN';
    }
    if (/^AH[0-9A-Z]+/i.test(token)) {
      const normalized = upper.replace(/[^A-Z0-9]/g, '');
      return `NODE_${normalized}`;
    }
    const sanitized = upper.replace(/[^A-Z0-9]/g, '');
    return sanitized ? `NODE_${sanitized}` : 'NODE_UNKNOWN';
  }
}
function looksBinary(text: string): boolean {
  let nonPrintable = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code >= 9 && code <= 13) || (code >= 32 && code <= 126)) {
      continue;
    }
    nonPrintable += 1;
    if (nonPrintable > 2) {
      return true;
    }
  }
  return false;
}
function safeDecodeText(payload: Uint8Array): string | null {
  try {
    const text = TEXT_DECODER.decode(payload);
    if (!text) return null;
    if (looksBinary(text)) return null;
    return text.trim();
  } catch {
    return null;
  }
}
function toNumber(value: string | number | null | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function stripAnsi(value: string): string {
  return value.replace(ANSI_STRIP_REGEX, '');
}
function isLogLine(value: string): boolean {
  return /^(INFO|WARN|ERROR|DEBUG|TRACE)\s*\|/i.test(value);
}
function restoreHumanReadableUnits(value: string): string {
  if (!value) {
    return value;
  }
  return value
    .replace(/#{1,2}\s*([CF])/gi, (_, unit: string) => ` ${unit.toUpperCase()}`)
    .replace(/\u00b0\s*([CF])/gi, (_, unit: string) => ` ${unit.toUpperCase()}`);
}
function extractChannelFromText(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /(?:^|[\s,;])(?:CH(?:ANNEL)?|C)[\s:=#-]*?(\d{1,3})\b/i.exec(value);
  if (!match) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  if (parsed <= 0 || parsed > 196) {
    return undefined;
  }
  return parsed;
}
function normalizeMac(mac: string): string {
  return mac.replace(/-/g, ':').toUpperCase();
}

function resolveDeviceType(band?: string): string | undefined {
  if (!band) {
    return undefined;
  }
  const normalized = band.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'B') {
    return 'BLE';
  }
  if (normalized === 'W') {
    return 'WiFi';
  }
  return normalized;
}

function formatCoordinate(value: number, isLatitude: boolean): string {
  const hemisphere = value >= 0 ? (isLatitude ? 'N' : 'E') : isLatitude ? 'S' : 'W';
  return `${Math.abs(value).toFixed(6)} deg ${hemisphere}`;
}

type ParsedLogLine = {
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | 'TRACE';
  timestamp?: string;
  source?: string;
  message: string;
};

function parseLogLine(line: string): ParsedLogLine | null {
  const match = LOG_LINE_REGEX.exec(line);
  if (!match?.groups) {
    return null;
  }
  const level = match.groups.level?.toUpperCase() as ParsedLogLine['level'];
  return {
    level,
    timestamp: match.groups.timestamp?.trim(),
    source: match.groups.source?.trim(),
    message: match.groups.message?.trim() ?? '',
  };
}
