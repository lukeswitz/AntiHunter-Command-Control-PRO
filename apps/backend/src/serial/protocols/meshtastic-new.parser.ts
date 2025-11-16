import { SerialParseResult, SerialProtocolParser } from '../serial.types';

// Simplified parser: only considers the payload after "msg=".
// If a line lacks msg=, it is emitted as raw.

// eslint-disable-next-line no-control-regex -- used to strip ANSI escape codes
const ANSI_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

const STATUS_REGEX =
  /\b(?<id>[A-Za-z0-9_.:-]+)?:?\s*STATUS:[\s\S]*?Temp[:\s]+(?<tempC>-?\d+(?:\.\d+)?)[cC](?:\/(?<tempF>-?\d+(?:\.\d+)?)[fF])?[\s\S]*?\bGPS[:\s]+(?<lat>-?\d+(?:\.\d+)?)[,\s]+(?<lon>-?\d+(?:\.\d+)?)(?:[,\s]+HDOP[:\s]*(?<hdop>-?\d+(?:\.\d+)?))?/i;

const TIME_TEMP_GPS_REGEX =
  /\b(?<id>[A-Za-z0-9_.:-]+)?\s*Time:[^\s]+\s+Temp[:\s]+(?<tempC>-?\d+(?:\.\d+)?)[cC](?:\/(?<tempF>-?\d+(?:\.\d+)?)[fF])?[\s\S]*?\bGPS[:\s]+(?<lat>-?\d+(?:\.\d+)?)[,\s]+(?<lon>-?\d+(?:\.\d+)?)/i;

const DEVICE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*DEVICE[:\s]+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})(?:\s+(?<band>[A-Za-z0-9]+))?\s+(?<rssi>-?\d+)(?:\s+C(?<channel>\d+))?(?:\s+N:(?<name>.+))?/i;

const TARGET_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*Target:\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)(?:\s+Type:(?<type>\w+))?(?:\s+Name:(?<name>[^ ]+))?(?:\s+GPS[=:](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;

const TELEMETRY_UPDATE_REGEX =
  /Node\s+(?<id>[A-Za-z0-9_.:-]+)\s+telemetry update\s*\((?<lat>-?\d+(?:\.\d+)?),\s*(?<lon>-?\d+(?:\.\d+)?)\)/i;

const VIBRATION_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*VIBRATION(?:_STATUS)?[:\s]+(?<payload>.+?)(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*(?<kind>[A-Z_]+_ACK(?::[A-Za-z0-9._-]+)?)/i;
const SCAN_DONE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*SCAN_DONE:\s*W=(?<w>\d+)\s+B=(?<b>\d+)\s+U=(?<u>\d+)\s+H=(?<h>\d+)\s+TX=(?<tx>\d+)\s+PEND=(?<pend>\d+)/i;
const DRONE_REGEX = /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*DRONE[:\s]+(?<payload>.+)$/i;
const DRONE_LINE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*DRONE[:\s]+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+ID:(?<droneId>[A-Za-z0-9_-]+)\b(?<rest>.*)$/i;
const DRONE_GPS_REGEX = /GPS:(?<lat>-?\d+(?:\.\d+)?),\s*(?<lon>-?\d+(?:\.\d+)?)/i;
const DRONE_ALT_REGEX = /ALT:(?<alt>-?\d+(?:\.\d+)?)/i;
const DRONE_SPD_REGEX = /SPD:(?<spd>-?\d+(?:\.\d+)?)/i;
const DRONE_OP_REGEX = /OP:(?<opLat>-?\d+(?:\.\d+)?),\s*(?<opLon>-?\d+(?:\.\d+)?)/i;
const DRONE_RSSI_REGEX = /\bR(?<rssi>-?\d+)\b/i;
const GPS_ROUTER_LOG_REGEX = /\bGPS\b.*(power state|updatePosition LOCAL)/i;
const GPS_LOCK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*GPS[:\s]+LOCKED\s+Location:(?<lat>-?\d+(?:\.\d+)?),\s*(?<lon>-?\d+(?:\.\d+)?)(?:\s+Satellites:(?<sats>\d+))?(?:\s+HDOP:(?<hdop>\d+(?:\.\d+)?))?/i;

const SOURCE_ID_REGEX = /(?:from=|fr=|node[=:])(?<source>[A-Za-z0-9_.:-]+)/i;

export class MeshtasticNewParser implements SerialProtocolParser {
  private pendingDeviceWithoutName?:
    | {
        nodeId: string;
        mac: string;
        rssi: number;
        band?: string;
        channel?: number;
        raw: string;
      }
    | undefined;
  private dedupeSet: Set<string> = new Set();
  private dedupeQueue: string[] = [];
  private carryFragment?: string;

  parseLine(rawLine: string): SerialParseResult[] {
    // Deduplicate across recent events (queue limited below).
    const sanitized = this.normalize(rawLine);
    if (!sanitized) {
      return [];
    }

    const combined = this.carryFragment ? `${this.carryFragment} ${sanitized}` : sanitized;
    this.carryFragment = undefined;

    const hasMsg = combined.includes(' msg=');

    if (!hasMsg) {
      // Try full parsing even without msg= for simulated lines (STATUS, etc.).
      const parsedNoMsg = this.parseMessage(combined, combined);
      if (parsedNoMsg.length) {
        this.pendingDeviceWithoutName = undefined;
        return parsedNoMsg;
      }

      // First try to parse DEVICE without msg= (router sometimes drops msg= when bundling).
      const deviceOnlyParsed = this.tryParseDeviceWithoutMsg(combined, combined);
      if (deviceOnlyParsed.length) {
        this.pendingDeviceWithoutName = undefined;
        return deviceOnlyParsed;
      }
      // Try DRONE without msg=
      const droneOnlyParsed = this.tryParseDroneWithoutMsg(combined, combined);
      if (droneOnlyParsed.length) {
        return droneOnlyParsed;
      }

      // If this looks like a fragment (very short), buffer and wait for next line.
      if (combined.length <= 3) {
        this.carryFragment = combined;
        return [];
      }

      // Drop router/log lines and known structured patterns to avoid spurious notifications.
      const looksLikeStructured =
        DEVICE_REGEX.test(combined) ||
        STATUS_REGEX.test(combined) ||
        TIME_TEMP_GPS_REGEX.test(combined) ||
        TARGET_REGEX.test(combined) ||
        TELEMETRY_UPDATE_REGEX.test(combined) ||
        VIBRATION_REGEX.test(combined) ||
        ACK_REGEX.test(combined) ||
        DRONE_REGEX.test(combined) ||
        SCAN_DONE_REGEX.test(combined) ||
        GPS_ROUTER_LOG_REGEX.test(combined) ||
        /\bReceived routing\b/i.test(combined) ||
        /\bDeviceTelemetry\b/i.test(combined) ||
        /\bPowerTelemetry\b/i.test(combined) ||
        /\bEnvironmentTelemetry\b/i.test(combined);
      if (looksLikeStructured) {
        this.pendingDeviceWithoutName = undefined;
        return [];
      }

      // Otherwise emit as raw.
      this.pendingDeviceWithoutName = undefined;
      return [{ kind: 'raw', raw: combined }];
    }

    const parsed = this.parseMessage(combined, combined);
    if (parsed.length) {
      this.pendingDeviceWithoutName = undefined;
      return parsed;
    }

    this.pendingDeviceWithoutName = undefined;
    return [];
  }

  reset(): void {
    this.pendingDeviceWithoutName = undefined;
    this.dedupeSet.clear();
    this.dedupeQueue = [];
  }

  private parseMessage(text: string, rawOriginal: string): SerialParseResult[] {
    const msgIndex = text.lastIndexOf('msg=');
    const hasMsg = msgIndex !== -1;
    const payload = (hasMsg ? text.slice(msgIndex + 4) : text).replace(/#$/, '').trim();

    const sourceIdMatch = SOURCE_ID_REGEX.exec(text) ?? /^(\w+):/.exec(text);
    const sourceId = this.normalizeNodeId(sourceIdMatch?.groups?.source ?? sourceIdMatch?.[1]);

    // Ignore echoed commands (e.g., "@ALL STATUS") so they don't appear in Terminal & Events.
    if (payload.startsWith('@')) {
      return [];
    }

    // Drop router/telemetry log payloads even if they have msg=.
    if (
      /\bReceived routing\b/i.test(payload) ||
      /\bDeviceTelemetry\b/i.test(payload) ||
      /\bPowerTelemetry\b/i.test(payload) ||
      /\bEnvironmentTelemetry\b/i.test(payload)
    ) {
      return [];
    }

    // If we have a pending device lacking a name, and this looks like a standalone name/SSID, enrich.
    if (
      this.pendingDeviceWithoutName &&
      payload.length > 0 &&
      payload.length <= 64 &&
      !/[:=]/.test(payload) &&
      !/\b(STATUS|DEVICE|ACK|SCAN|GPS|Target)\b/i.test(payload)
    ) {
      const pending = this.pendingDeviceWithoutName;
      this.pendingDeviceWithoutName = undefined;
      return this.dedupe([
        {
          kind: 'target-detected',
          nodeId: pending.nodeId,
          mac: pending.mac,
          rssi: pending.rssi,
          name: payload.trim(),
          ...(pending.band && { type: pending.band }),
          ...(Number.isFinite(pending.channel) && { channel: pending.channel }),
          raw: rawOriginal,
        },
      ]);
    }

    const statusMatch = STATUS_REGEX.exec(payload);
    if (statusMatch?.groups) {
      const nodeId = this.normalizeNodeId(statusMatch.groups.id) || sourceId;
      const lat = Number(statusMatch.groups.lat);
      const lon = Number(statusMatch.groups.lon);
      if (nodeId && Number.isFinite(lat) && Number.isFinite(lon)) {
        const tempC = Number(statusMatch.groups.tempC);
        const tempF = statusMatch.groups.tempF ? Number(statusMatch.groups.tempF) : undefined;
        const results: SerialParseResult[] = [
          {
            kind: 'node-telemetry',
            nodeId,
            lat,
            lon,
            raw: rawOriginal,
            lastMessage: payload,
            ...(Number.isFinite(tempC) && { temperatureC: tempC }),
            ...(Number.isFinite(tempF) && { temperatureF: tempF }),
          },
        ];
        results.push({
          kind: 'alert',
          level: 'NOTICE',
          category: 'status',
          nodeId,
          message: payload,
          raw: rawOriginal,
        });
        return this.dedupe(results);
      }
    }

      const timeGpsMatch = TIME_TEMP_GPS_REGEX.exec(payload);
      if (timeGpsMatch?.groups) {
        const nodeId = this.normalizeNodeId(timeGpsMatch.groups.id) || sourceId;
        const lat = Number(timeGpsMatch.groups.lat);
        const lon = Number(timeGpsMatch.groups.lon);
        if (nodeId && Number.isFinite(lat) && Number.isFinite(lon)) {
          const tempC = Number(timeGpsMatch.groups.tempC);
          const tempF = timeGpsMatch.groups.tempF ? Number(timeGpsMatch.groups.tempF) : undefined;
          return this.dedupe([
            {
              kind: 'node-telemetry',
              nodeId,
              lat,
              lon,
              raw: rawOriginal,
              lastMessage: payload,
              ...(Number.isFinite(tempC) && { temperatureC: tempC }),
              ...(Number.isFinite(tempF) && { temperatureF: tempF }),
            },
          ]);
        }
      }

      const gpsLockMatch = GPS_LOCK_REGEX.exec(payload);
      if (gpsLockMatch?.groups) {
        const nodeId = this.normalizeNodeId(gpsLockMatch.groups.id) || sourceId;
        const lat = Number(gpsLockMatch.groups.lat);
        const lon = Number(gpsLockMatch.groups.lon);
        const sats = gpsLockMatch.groups.sats ? Number(gpsLockMatch.groups.sats) : undefined;
        const hdop = gpsLockMatch.groups.hdop ? Number(gpsLockMatch.groups.hdop) : undefined;
        if (nodeId && Number.isFinite(lat) && Number.isFinite(lon)) {
          return this.dedupe([
            {
              kind: 'node-telemetry',
              nodeId,
              lat,
              lon,
              raw: rawOriginal,
              lastMessage: payload,
              ...(Number.isFinite(hdop) && { hdop }),
              ...(Number.isFinite(sats) && { satellites: sats }),
            },
            {
              kind: 'alert',
              level: 'NOTICE',
              category: 'status',
              nodeId,
              message: payload,
              raw: rawOriginal,
            },
          ]);
        }
      }

    const targetMatch = TARGET_REGEX.exec(payload);
    if (targetMatch?.groups) {
      const nodeId = this.normalizeNodeId(targetMatch.groups.id) || sourceId;
      if (nodeId) {
        const mac = targetMatch.groups.mac.toUpperCase();
        const lat = targetMatch.groups.lat ? Number(targetMatch.groups.lat) : undefined;
        const lon = targetMatch.groups.lon ? Number(targetMatch.groups.lon) : undefined;
        const rssi = Number(targetMatch.groups.rssi);
        const type = targetMatch.groups.type ? targetMatch.groups.type.toUpperCase() : undefined;
        return this.dedupe([
          {
            kind: 'target-detected',
            nodeId,
            mac,
            rssi,
            type,
            lat,
            lon,
            raw: rawOriginal,
          },
        ]);
      }
    }

    const deviceMatch = DEVICE_REGEX.exec(payload);
    if (deviceMatch?.groups) {
      const nodeId = this.normalizeNodeId(deviceMatch.groups.id) || sourceId;
      const mac = deviceMatch.groups.mac.toUpperCase();
      if (nodeId) {
        const name = this.stripTrailingHash(deviceMatch.groups.name?.trim());
        const band = this.normalizeBand(deviceMatch.groups.band?.trim());
        const channel = deviceMatch.groups.channel ? Number(deviceMatch.groups.channel) : undefined;
        if (!name) {
          this.pendingDeviceWithoutName = {
            nodeId,
            mac,
            rssi: Number(deviceMatch.groups.rssi),
            band,
            channel,
            raw: rawOriginal,
          };
        } else {
          this.pendingDeviceWithoutName = undefined;
        }
        return this.dedupe([
          {
            kind: 'target-detected',
            nodeId,
            mac,
            rssi: Number(deviceMatch.groups.rssi),
            ...(band && { type: band }),
            ...(Number.isFinite(channel) && { channel }),
            ...(name && { name, ssid: name }),
            raw: rawOriginal,
          },
        ]);
      }
    }

    const telemetryMatch = TELEMETRY_UPDATE_REGEX.exec(payload);
    if (telemetryMatch?.groups) {
      const nodeId = this.normalizeNodeId(telemetryMatch.groups.id) || sourceId;
      const lat = Number(telemetryMatch.groups.lat);
      const lon = Number(telemetryMatch.groups.lon);
      if (nodeId && Number.isFinite(lat) && Number.isFinite(lon)) {
        return this.dedupe([
          {
            kind: 'node-telemetry',
            nodeId,
            lat,
            lon,
            raw: rawOriginal,
            lastMessage: payload,
          },
        ]);
      }
    }

    // Keep the original payload for vibration messages (avoid greedy truncation).
    const vibrationMatch = VIBRATION_REGEX.exec(payload);
    if (vibrationMatch?.groups) {
      const nodeId = this.normalizeNodeId(vibrationMatch.groups.id) || sourceId;
      if (nodeId) {
        const lat = vibrationMatch.groups.lat ? Number(vibrationMatch.groups.lat) : undefined;
        const lon = vibrationMatch.groups.lon ? Number(vibrationMatch.groups.lon) : undefined;
        const rawMessage = (vibrationMatch.groups.payload ?? payload).trim();
        const message =
          rawMessage.length >= 5
            ? rawMessage
            : payload.trim().length >= 5
              ? payload.trim()
              : text.trim();
        return this.dedupe([
          {
            kind: 'alert',
            level: 'NOTICE',
            category: 'vibration',
            nodeId,
            message,
            raw: rawOriginal,
            ...(Number.isFinite(lat) && Number.isFinite(lon) && { data: { lat, lon } }),
          },
        ]);
      }
    }

    const ackMatch = ACK_REGEX.exec(payload);
    if (ackMatch?.groups) {
      const nodeId = this.normalizeNodeId(ackMatch.groups.id) || sourceId;
      if (nodeId) {
        return this.dedupe([
          {
            kind: 'command-ack',
            nodeId,
            ackType: ackMatch.groups.kind,
            status: 'OK',
            raw: rawOriginal,
          },
        ]);
      }
    }

    const droneMatch = DRONE_REGEX.exec(payload);
    if (droneMatch?.groups) {
      const nodeId = this.normalizeNodeId(droneMatch.groups.id) || sourceId;
      if (nodeId) {
        // Try to parse detailed DRONE line
        const detailed = DRONE_LINE_REGEX.exec(payload);
        if (detailed?.groups) {
          const rest = detailed.groups.rest ?? '';
          const gps = DRONE_GPS_REGEX.exec(rest);
          const op = DRONE_OP_REGEX.exec(rest);
          const alt = DRONE_ALT_REGEX.exec(rest);
          const spd = DRONE_SPD_REGEX.exec(rest);
          const rssi = DRONE_RSSI_REGEX.exec(rest);
          const lat = gps ? Number(gps.groups?.lat) : undefined;
          const lon = gps ? Number(gps.groups?.lon) : undefined;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return this.dedupe([
              {
                kind: 'alert',
                level: 'NOTICE',
                category: 'drone',
                nodeId,
                message: payload,
                raw: rawOriginal,
              },
            ]);
          }
          return this.dedupe([
            {
              kind: 'drone-telemetry',
              nodeId,
              droneId: detailed.groups.droneId,
              mac: detailed.groups.mac.toUpperCase(),
              lat: lat as number,
              lon: lon as number,
              altitude: alt ? Number(alt.groups?.alt) : undefined,
              speed: spd ? Number(spd.groups?.spd) : undefined,
              operatorLat: op ? Number(op.groups?.opLat) : undefined,
              operatorLon: op ? Number(op.groups?.opLon) : undefined,
              rssi: rssi ? Number(rssi.groups?.rssi) : undefined,
              raw: rawOriginal,
            },
          ]);
        }
        return this.dedupe([
          {
            kind: 'alert',
            level: 'NOTICE',
            category: 'drone',
            nodeId,
            message: payload,
            raw: rawOriginal,
          },
        ]);
      }
    }

    const scanDoneMatch = SCAN_DONE_REGEX.exec(payload);
    if (scanDoneMatch?.groups) {
      const nodeId = this.normalizeNodeId(scanDoneMatch.groups.id) || sourceId;
      if (nodeId) {
        const data = {
          w: Number(scanDoneMatch.groups.w),
          b: Number(scanDoneMatch.groups.b),
          u: Number(scanDoneMatch.groups.u),
          h: Number(scanDoneMatch.groups.h),
          tx: Number(scanDoneMatch.groups.tx),
          pend: Number(scanDoneMatch.groups.pend),
        };
        return this.dedupe([
          {
            kind: 'alert',
            level: 'NOTICE',
            category: 'scan',
            nodeId,
            message: payload,
            raw: rawOriginal,
            data,
          },
        ]);
      }
    }

    // If payload contains a colon but matched none of the known patterns, drop it (likely malformed).
    if (
      payload.includes(':') &&
      !STATUS_REGEX.test(payload) &&
      !TIME_TEMP_GPS_REGEX.test(payload) &&
      !TARGET_REGEX.test(payload) &&
      !DEVICE_REGEX.test(payload) &&
      !TELEMETRY_UPDATE_REGEX.test(payload) &&
      !VIBRATION_REGEX.test(payload) &&
      !ACK_REGEX.test(payload)
    ) {
      return [];
    }

    // Fallback: treat any msg= payload that didn't match as a status alert.
    if (payload && sourceId) {
      // If this is just a free-text fragment (no key/value), drop unless we have pending device enrichment.
      if (!payload.includes(':')) {
        return [];
      }
      return this.dedupe([
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'status',
          nodeId: sourceId,
          message: payload,
          raw: rawOriginal,
        },
      ]);
    }

    return [];
  }

  // Handle DEVICE/SCAN_DONE lines that arrive without msg= (bundled/raw router output).
  private tryParseDeviceWithoutMsg(text: string, rawOriginal: string): SerialParseResult[] {
    const deviceMatch = DEVICE_REGEX.exec(text);
    if (deviceMatch?.groups) {
      const nodeId = this.normalizeNodeId(deviceMatch.groups.id);
      const sourceIdMatch = SOURCE_ID_REGEX.exec(text) ?? /^(\w+):/.exec(text);
      const sourceId = this.normalizeNodeId(sourceIdMatch?.groups?.source ?? sourceIdMatch?.[1]);
      const mac = deviceMatch.groups.mac.toUpperCase();
      const band = this.normalizeBand(deviceMatch.groups.band?.trim());
      const channel = deviceMatch.groups.channel ? Number(deviceMatch.groups.channel) : undefined;
      const name = this.stripTrailingHash(deviceMatch.groups.name?.trim());
      const node = nodeId || sourceId;
      if (!node) {
        return [];
      }
      if (!name) {
        this.pendingDeviceWithoutName = {
          nodeId: node,
          mac,
          rssi: Number(deviceMatch.groups.rssi),
          band,
          channel,
          raw: rawOriginal,
        };
      } else {
        this.pendingDeviceWithoutName = undefined;
      }
      return this.dedupe([
        {
          kind: 'target-detected',
          nodeId: node,
          mac,
          rssi: Number(deviceMatch.groups.rssi),
          ...(band && { type: band }),
          ...(Number.isFinite(channel) && { channel }),
          ...(name && { name }),
          raw: rawOriginal,
        },
      ]);
    }

    const scanDoneMatch = SCAN_DONE_REGEX.exec(text);
    if (scanDoneMatch?.groups) {
      const nodeId =
        this.normalizeNodeId(scanDoneMatch.groups.id) ||
        this.normalizeNodeId(SOURCE_ID_REGEX.exec(text)?.groups?.source);
      if (!nodeId) {
        return [];
      }
      const data = {
        w: Number(scanDoneMatch.groups.w),
        b: Number(scanDoneMatch.groups.b),
        u: Number(scanDoneMatch.groups.u),
        h: Number(scanDoneMatch.groups.h),
        tx: Number(scanDoneMatch.groups.tx),
        pend: Number(scanDoneMatch.groups.pend),
      };
      return this.dedupe([
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'scan',
          nodeId,
          message: text.trim(),
          raw: rawOriginal,
          data,
        },
      ]);
    }
    return [];
  }

  private tryParseDroneWithoutMsg(text: string, rawOriginal: string): SerialParseResult[] {
    const detailed = DRONE_LINE_REGEX.exec(text);
    if (detailed?.groups) {
      const rest = detailed.groups.rest ?? '';
      const gps = DRONE_GPS_REGEX.exec(rest);
      const op = DRONE_OP_REGEX.exec(rest);
      const alt = DRONE_ALT_REGEX.exec(rest);
      const spd = DRONE_SPD_REGEX.exec(rest);
      const rssi = DRONE_RSSI_REGEX.exec(rest);
      const nodeId =
        this.normalizeNodeId(detailed.groups.id) ||
        this.normalizeNodeId(SOURCE_ID_REGEX.exec(text)?.groups?.source);
      if (!nodeId) {
        return [];
      }
      const lat = gps ? Number(gps.groups?.lat) : undefined;
      const lon = gps ? Number(gps.groups?.lon) : undefined;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return this.dedupe([
          {
            kind: 'alert',
            level: 'NOTICE',
            category: 'drone',
            nodeId,
            message: text.trim(),
            raw: rawOriginal,
          },
        ]);
      }
      return this.dedupe([
        {
          kind: 'drone-telemetry',
          nodeId,
          droneId: detailed.groups.droneId,
          mac: detailed.groups.mac.toUpperCase(),
          lat: lat as number,
          lon: lon as number,
          altitude: alt ? Number(alt.groups?.alt) : undefined,
          speed: spd ? Number(spd.groups?.spd) : undefined,
          operatorLat: op ? Number(op.groups?.opLat) : undefined,
          operatorLon: op ? Number(op.groups?.opLon) : undefined,
          rssi: rssi ? Number(rssi.groups?.rssi) : undefined,
          raw: rawOriginal,
        },
      ]);
    }
    return [];
  }

  private dedupe(events: SerialParseResult[]): SerialParseResult[] {
    const result: SerialParseResult[] = [];
    for (const ev of events) {
      const key = this.buildKey(ev);
      if (this.dedupeSet.has(key)) {
        continue;
      }
      this.dedupeSet.add(key);
      this.dedupeQueue.push(key);
      if (this.dedupeQueue.length > 200) {
        const old = this.dedupeQueue.shift();
        if (old) {
          this.dedupeSet.delete(old);
        }
      }
      result.push(ev);
    }
    return result;
  }

  private buildKey(event: SerialParseResult): string {
    switch (event.kind) {
      case 'target-detected': {
        const channel = (event as { channel?: number }).channel ?? '';
        const ssid = (event as { ssid?: string }).ssid ?? '';
        const type = (event as { type?: string }).type ?? '';
        const name = (event as { name?: string }).name ?? '';
        return `device|${event.nodeId}|${event.mac}|${event.rssi}|${channel}|${ssid}|${type}|${name}`;
      }
      case 'command-ack':
        return `ack|${event.nodeId}|${event.ackType}|${event.status}`;
      case 'node-telemetry':
        return `telemetry|${event.nodeId}|${event.lat}|${event.lon}|${(event as { temperatureC?: number }).temperatureC ?? ''}|${(event as { temperatureF?: number }).temperatureF ?? ''}`;
      case 'alert':
        return `alert|${event.nodeId ?? ''}|${event.category}|${event.message}`;
      case 'drone-telemetry':
        return `drone|${event.nodeId ?? ''}|${event.droneId}|${event.mac ?? ''}|${event.lat ?? ''}|${event.lon ?? ''}|${(event as { altitude?: number }).altitude ?? ''}|${(event as { speed?: number }).speed ?? ''}`;
      default:
        return JSON.stringify(event);
    }
  }

  private normalize(value: string): string {
    if (!value) {
      return '';
    }
    // Strip ANSI sequences and control chars except whitespace.
    let cleaned = value.replace(ANSI_REGEX, '');
    cleaned = Array.from(cleaned)
      .filter((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20;
      })
      .join('');
    // Drop leading garbage before first letter/number/@/AHL* etc.
    const firstUseful = cleaned.search(/[A-Za-z0-9@]/);
    if (firstUseful > 0) {
      cleaned = cleaned.slice(firstUseful);
    }
    // Drop leading channel markers like "1 :" if present.
    const markerMatch = /^\s*\d+\s*:\s*(.+)$/.exec(cleaned);
    if (markerMatch?.[1]) {
      cleaned = markerMatch[1];
    }
    // Remove placeholder Fahrenheit fragments.
    cleaned = cleaned.replace(/\/?undefinedf\b/gi, '');
    // Drop stray leading "0m" artifacts from colorized logs.
    cleaned = cleaned.replace(/^0m\s+/, '');
    return cleaned.trim();
  }

  private normalizeNodeId(nodeId?: string): string | undefined {
    if (!nodeId) {
      return undefined;
    }
    return nodeId.replace(/:$/, '');
  }

  private stripTrailingHash(value?: string): string | undefined {
    if (!value) {
      return undefined;
    }
    return value.replace(/#+$/, '').trim();
  }

  private normalizeBand(band?: string): string | undefined {
    if (!band) {
      return undefined;
    }
    const upper = band.toUpperCase();
    if (upper === 'W') {
      return 'WiFi';
    }
    if (upper === 'B') {
      return 'BLE';
    }
    return upper;
  }
}
