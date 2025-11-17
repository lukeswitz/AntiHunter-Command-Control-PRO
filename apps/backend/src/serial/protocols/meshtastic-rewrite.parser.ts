import { SerialParseResult, SerialProtocolParser } from '../serial.types';

// Parser rewritten from catalog in meshmessages.xlsx/README.
// Triangulation multi-line results are left as raw.

// eslint-disable-next-line no-control-regex -- used to strip ANSI escape codes
const ANSI_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

const STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*STATUS:\s*Mode:(?<mode>\S+)\s+Scan:(?<scan>\S+)\s+Hits:(?<hits>\d+)\s+(?:Targets:(?<targets>\d+)\s+)?Unique:(?<unique>\d+)\s+Temp:(?<tempC>-?\d+(?:\.\d+)?)[cC](?:\/(?<tempF>-?\d+(?:\.\d+)?)[Ff])?\s+Up:(?<up>[0-9:]+)(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?(?:\s+HDOP[:=](?<hdop>-?\d+(?:\.\d+)?))?/i;
const STARTUP_REGEX = /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*STARTUP:\s*(?<msg>.+)$/i;
const GPS_LOCK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*GPS:\s*LOCKED\s+Location[=:](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?)(?:\s+Satellites[=:](?<sats>\d+))?(?:\s+HDOP[=:](?<hdop>-?\d+(?:\.\d+)?))?/i;
const GPS_LOST_REGEX = /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*GPS:\s*LOST/i;
const NODE_HB_REGEX =
  /^\[NODE_HB\]\s*(?<id>[A-Za-z0-9_.:-]+)\s+Time:(?<time>[^ ]+)\s+Temp:(?<tempC>-?\d+(?:\.\d+)?)(?:\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;

const TARGET_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*Target:\s*(?<type>\w+)\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)(?:\s+Name:(?<name>[^ ]+))?(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const DEVICE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*DEVICE:(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+(?<band>[A-Za-z])\s+(?<rssi>-?\d+)(?:\s+C(?<channel>\d+))?(?:\s+N:(?<name>.+))?/i;
const DRONE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*DRONE:\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+ID:(?<droneId>[A-Za-z0-9_-]+)\s+R(?<rssi>-?\d+)\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?)(?:\s+ALT:(?<alt>-?\d+(?:\.\d+)?))?(?:\s+SPD:(?<spd>-?\d+(?:\.\d+)?))?(?:\s+OP:(?<opLat>-?\d+(?:\.\d+)?),(?<opLon>-?\d+(?:\.\d+)?))?/i;

const ANOMALY_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ANOMALY-(?<kind>NEW|RETURN|RSSI):\s*(?<type>\w+)\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})(?:\s+RSSI:(?<rssi>-?\d+))?(?:\s+Old:(?<old>-?\d+)\s+New:(?<new>-?\d+)\s+Delta:(?<delta>-?\d+))?(?:\s+Name:(?<name>[^ ]+))?/i;

const ATTACK_LONG_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ATTACK:\s*(?<kind>DEAUTH|DISASSOC)(?:\s+\[(?<mode>BROADCAST|TARGETED)\])?\s+SRC:(?<src>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+DST:(?<dst>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)d?Bm?\s+CH:(?<chan>\d+)/i;
const ATTACK_SHORT_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ATTACK:\s*(?<kind>DEAUTH|DISASSOC)\s+(?<src>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})->(?<dst>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+R(?<rssi>-?\d+)\s+C(?<chan>\d+)/i;

const RANDOM_IDENTITY_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*IDENTITY:(?<tag>T-[A-Za-z0-9]+)\s+(?<band>[WB])\s+MACs:(?<macs>\d+)\s+Conf:(?<conf>\d+(?:\.\d+)?)\s+Sess:(?<sess>\d+)\s+Anchor:(?<anchor>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})/i;
const RANDOM_DONE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*RANDOMIZATION_DONE:\s*Identities=(?<ids>\d+)\s+Sessions=(?<sess>\d+)\s+TX=(?<tx>\d+)\s+PEND=(?<pend>\d+)/i;

const VIBRATION_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*VIBRATION:\s*(?<msg>.+?)(?:\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?(?:\s+TAMPER_ERASE_IN:(?<erase>\d+)s)?/i;
const SETUP_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*SETUP_(?<kind>MODE|COMPLETE):\s*(?<msg>.+)$/i;
const TAMPER_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*TAMPER_(?<kind>DETECTED|CANCELLED):?(?:\s*(?<msg>.+))?/i;
const ERASE_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*ERASE_(?<kind>EXECUTING|ACK):(?<msg>.+)?/i;
const BASELINE_STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*BASELINE_STATUS:\s*Scanning:(?<scanning>YES|NO)\s+Established:(?<est>YES|NO)\s+Devices:(?<dev>\d+)\s+Anomalies:(?<anom>\d+)\s+Phase1:(?<phase>[A-Z]+)/i;

const ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?<kind>(?:SCAN|DEVICE_SCAN|DRONE|DEAUTH|RANDOMIZATION|BASELINE|CONFIG|TRIANGULATE(?:_STOP)?|STOP|REBOOT)_ACK):(?<status>[A-Z_]+)/i;
const WIPE_TOKEN_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*WIPE_TOKEN:(?<token>[A-Za-z0-9_:-]+)/i;
const TRI_ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_ACK:(?<target>.+)$/i;
const TRI_STOP_ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_STOP_ACK/i;
const BASELINE_ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*BASELINE_ACK:(?<status>[A-Z_]+)/i;

const NODE_ID_FALLBACK = /^([A-Za-z0-9_.:-]+)/;

export class MeshtasticRewriteParser implements SerialProtocolParser {
  parseLine(rawLine: string): SerialParseResult[] {
    const sanitized = this.normalize(rawLine);
    if (!sanitized) return [];

    // Drop tiny ANSI fragments like "0m" to avoid contaminating the next line.
    if (sanitized.length <= 3 && /^[0m\s]*$/i.test(sanitized)) {
      return [];
    }

    const msgIndex = sanitized.lastIndexOf('msg=');
    const payloadRaw = msgIndex >= 0 ? sanitized.slice(msgIndex + 4).trim() : sanitized;
    const payload = this.stripTrailingHash(payloadRaw.replace(/^0m\s*/i, ''));
    const sourceId = this.extractSourceId(sanitized);

    const parsed =
      this.parseTarget(payload, sourceId, sanitized) ||
      this.parseDevice(payload, sourceId, sanitized) ||
      this.parseDrone(payload, sourceId, sanitized) ||
      this.parseAnomaly(payload, sourceId, sanitized) ||
      this.parseAttack(payload, sourceId, sanitized) ||
      this.parseRandomization(payload, sourceId, sanitized) ||
      this.parseVibration(payload, sourceId, sanitized) ||
      this.parseTamper(payload, sourceId, sanitized) ||
      this.parseStatus(payload, sourceId, sanitized) ||
      this.parseStartupGpsHeartbeat(payload, sourceId, sanitized) ||
      this.parseAck(payload, sourceId, sanitized);

    if (parsed) return parsed;
    return msgIndex >= 0 ? [] : [{ kind: 'raw', raw: sanitized }];
  }

  reset(): void {
    // stateless parser
  }

  private parseTarget(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = TARGET_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'target-detected',
        nodeId: nodeId ?? m.groups.id,
        mac: m.groups.mac.toUpperCase(),
        rssi: Number(m.groups.rssi),
        type: m.groups.type,
        name: m.groups.name,
        lat: m.groups.lat ? Number(m.groups.lat) : undefined,
        lon: m.groups.lon ? Number(m.groups.lon) : undefined,
        raw,
      },
    ];
  }

  private parseDevice(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = DEVICE_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'target-detected',
        nodeId: nodeId ?? m.groups.id,
        mac: m.groups.mac.toUpperCase(),
        rssi: Number(m.groups.rssi),
        type: this.normalizeBand(m.groups.band),
        channel: m.groups.channel ? Number(m.groups.channel) : undefined,
        name: m.groups.name,
        raw,
      },
    ];
  }

  private parseDrone(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = DRONE_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'drone-telemetry',
        nodeId: nodeId ?? m.groups.id,
        droneId: m.groups.droneId,
        mac: m.groups.mac.toUpperCase(),
        rssi: Number(m.groups.rssi),
        lat: Number(m.groups.lat),
        lon: Number(m.groups.lon),
        altitude: m.groups.alt ? Number(m.groups.alt) : undefined,
        speed: m.groups.spd ? Number(m.groups.spd) : undefined,
        operatorLat: m.groups.opLat ? Number(m.groups.opLat) : undefined,
        operatorLon: m.groups.opLon ? Number(m.groups.opLon) : undefined,
        raw,
      },
    ];
  }

  private parseAnomaly(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = ANOMALY_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'alert',
        level: 'NOTICE',
        category: 'anomaly',
        nodeId: nodeId ?? m.groups.id,
        message: payload,
        data: {
          kind: m.groups.kind,
          type: m.groups.type,
          mac: m.groups.mac.toUpperCase(),
          rssi: m.groups.rssi ? Number(m.groups.rssi) : undefined,
          old: m.groups.old ? Number(m.groups.old) : undefined,
          new: m.groups.new ? Number(m.groups.new) : undefined,
          delta: m.groups.delta ? Number(m.groups.delta) : undefined,
          name: m.groups.name,
        },
        raw,
      },
    ];
  }

  private parseAttack(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const long = ATTACK_LONG_REGEX.exec(payload);
    if (long?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'attack',
          nodeId: nodeId ?? long.groups.id,
          message: payload,
          data: {
            kind: long.groups.kind,
            mode: long.groups.mode,
            src: long.groups.src.toUpperCase(),
            dst: long.groups.dst.toUpperCase(),
            rssi: Number(long.groups.rssi),
            channel: Number(long.groups.chan),
          },
          raw,
        },
      ];
    }
    const short = ATTACK_SHORT_REGEX.exec(payload);
    if (short?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'attack',
          nodeId: nodeId ?? short.groups.id,
          message: payload,
          data: {
            kind: short.groups.kind,
            src: short.groups.src.toUpperCase(),
            dst: short.groups.dst.toUpperCase(),
            rssi: Number(short.groups.rssi),
            channel: Number(short.groups.chan),
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseRandomization(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const id = RANDOM_IDENTITY_REGEX.exec(payload);
    if (id?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'randomization',
          nodeId: nodeId ?? id.groups.id,
          message: payload,
          data: {
            tag: id.groups.tag,
            band: id.groups.band,
            macs: Number(id.groups.macs),
            confidence: Number(id.groups.conf),
            sessions: Number(id.groups.sess),
            anchor: id.groups.anchor.toUpperCase(),
          },
          raw,
        },
      ];
    }
    const done = RANDOM_DONE_REGEX.exec(payload);
    if (done?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'randomization',
          nodeId: nodeId ?? done.groups.id,
          message: payload,
          data: {
            identities: Number(done.groups.ids),
            sessions: Number(done.groups.sess),
            tx: Number(done.groups.tx),
            pending: Number(done.groups.pend),
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseVibration(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const vib = VIBRATION_REGEX.exec(payload);
    if (vib?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'vibration',
          nodeId: nodeId ?? vib.groups.id,
          message: payload,
          data: {
            lat: vib.groups.lat ? Number(vib.groups.lat) : undefined,
            lon: vib.groups.lon ? Number(vib.groups.lon) : undefined,
            eraseIn: vib.groups.erase ? Number(vib.groups.erase) : undefined,
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseTamper(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const setup = SETUP_REGEX.exec(payload);
    if (setup?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'setup',
          nodeId: nodeId ?? setup.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    const tamper = TAMPER_REGEX.exec(payload);
    if (tamper?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'tamper',
          nodeId: nodeId ?? tamper.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    const erase = ERASE_REGEX.exec(payload);
    if (erase?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'erase',
          nodeId: nodeId ?? erase.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    const baseline = BASELINE_STATUS_REGEX.exec(payload);
    if (baseline?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'baseline',
          nodeId: nodeId ?? baseline.groups.id,
          message: payload,
          data: {
            scanning: baseline.groups.scanning,
            established: baseline.groups.est,
            devices: Number(baseline.groups.dev),
            anomalies: Number(baseline.groups.anom),
            phase: baseline.groups.phase,
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseStatus(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = STATUS_REGEX.exec(payload);
    if (!m?.groups) return null;
    const resolvedNodeId = nodeId ?? m.groups.id;
    const lat = m.groups.lat ? Number(m.groups.lat) : undefined;
    const lon = m.groups.lon ? Number(m.groups.lon) : undefined;
    const hdop = m.groups.hdop ? Number(m.groups.hdop) : undefined;
    const msgBase = hdop != null ? payload.replace(/HDOP[^\s]*/i, `HDOP=${hdop}`) : payload;
    const msg = this.stripTrailingHash(msgBase);
    const normalizedLat = Number.isFinite(lat) ? (lat as number) : Number.NaN;
    const normalizedLon = Number.isFinite(lon) ? (lon as number) : Number.NaN;
    const results: SerialParseResult[] = [];
    // Emit telemetry when we have a nodeId; allow lat/lon to be undefined if not provided.
    if (resolvedNodeId) {
      const telemetry: SerialParseResult = {
        kind: 'node-telemetry',
        nodeId: resolvedNodeId,
        lat: normalizedLat,
        lon: normalizedLon,
        raw,
        lastMessage: msg,
        temperatureC: m.groups.tempC ? Number(m.groups.tempC) : undefined,
        temperatureF: m.groups.tempF ? Number(m.groups.tempF) : undefined,
      };
      results.push(telemetry);
    }
    results.push({
      kind: 'alert',
      level: 'NOTICE',
      category: 'status',
      nodeId: resolvedNodeId,
      message: msg,
      raw,
      data: { hdop },
    });
    return results;
  }

  private parseStartupGpsHeartbeat(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const hb = NODE_HB_REGEX.exec(payload);
    if (hb?.groups) {
      return [
        {
          kind: 'node-telemetry',
          nodeId: nodeId ?? hb.groups.id,
          lat: hb.groups.lat ? Number(hb.groups.lat) : 0,
          lon: hb.groups.lon ? Number(hb.groups.lon) : 0,
          raw,
          lastMessage: payload,
          temperatureC: hb.groups.tempC ? Number(hb.groups.tempC) : undefined,
        },
      ];
    }
    const gpsLock = GPS_LOCK_REGEX.exec(payload);
    if (gpsLock?.groups) {
      const results: SerialParseResult[] = [
        {
          kind: 'node-telemetry',
          nodeId: nodeId ?? gpsLock.groups.id,
          lat: Number(gpsLock.groups.lat),
          lon: Number(gpsLock.groups.lon),
          raw,
          lastMessage: payload,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'gps',
          nodeId: nodeId ?? gpsLock.groups.id,
          message: payload,
          raw,
          data: {
            lat: Number(gpsLock.groups.lat),
            lon: Number(gpsLock.groups.lon),
            hdop: gpsLock.groups.hdop ? Number(gpsLock.groups.hdop) : undefined,
            sats: gpsLock.groups.sats ? Number(gpsLock.groups.sats) : undefined,
          },
        },
      ];
      return results;
    }
    if (GPS_LOST_REGEX.test(payload)) {
      const id = this.extractNodeId(payload, nodeId);
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'gps',
          nodeId: id,
          message: payload,
          raw,
        },
      ];
    }
    const startup = STARTUP_REGEX.exec(payload);
    if (startup?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'startup',
          nodeId: nodeId ?? startup.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    return null;
  }

  private parseAck(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const ack = ACK_REGEX.exec(payload);
    if (ack?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? ack.groups.id,
          ackType: ack.groups.kind,
          status: ack.groups.status,
          raw,
        },
      ];
    }
    const triAck = TRI_ACK_REGEX.exec(payload);
    if (triAck?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: nodeId ?? triAck.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    if (TRI_STOP_ACK_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: nodeId ?? this.extractNodeId(payload, undefined),
          message: payload,
          raw,
        },
      ];
    }
    if (BASELINE_ACK_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'baseline',
          nodeId: nodeId ?? this.extractNodeId(payload, undefined),
          message: payload,
          raw,
        },
      ];
    }
    const wipe = WIPE_TOKEN_REGEX.exec(payload);
    if (wipe?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'erase',
          nodeId: nodeId ?? wipe.groups.id,
          message: payload,
          raw,
          data: { token: wipe.groups.token },
        },
      ];
    }
    return null;
  }

  private normalize(value: string): string {
    if (!value) return '';
    let cleaned = value.replace(ANSI_REGEX, '');
    cleaned = Array.from(cleaned)
      .filter((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20;
      })
      .join('');
    return cleaned.trim();
  }

  private extractSourceId(text: string): string | undefined {
    const m = /node[=:](?<n>[A-Za-z0-9_.:-]+)/i.exec(text) ?? NODE_ID_FALLBACK.exec(text);
    return m?.groups ? (m.groups['n'] ?? m[1]) : undefined;
  }

  private extractNodeId(payload: string, fallback?: string): string | undefined {
    const m = NODE_ID_FALLBACK.exec(payload);
    return m?.[1] ?? fallback;
  }

  private stripTrailingHash(value: string): string {
    return value.replace(/#+$/, '').trim();
  }

  private normalizeBand(band?: string): string | undefined {
    if (!band) return undefined;
    const b = band.toUpperCase();
    if (b === 'W') return 'WiFi';
    if (b === 'B') return 'BLE';
    return b;
  }
}
