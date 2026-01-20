import { SerialParseResult, SerialProtocolParser } from '../serial.types';

// Parser rewritten from catalog in meshmessages.xlsx/README.
// Triangulation multi-line results are left as raw.

// eslint-disable-next-line no-control-regex -- used to strip ANSI escape codes
const ANSI_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

const STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*STATUS:\s*Mode:(?<mode>\S+)\s+Scan:(?<scan>\S+)\s+Hits:(?<hits>\d+)\s+(?:Targets:(?<targets>\d+)\s+)?Temp:(?<tempC>-?\d+(?:\.\d+)?)[cC](?:\/(?<tempF>-?\d+(?:\.\d+)?)[Ff])?\s+Up:(?<up>[0-9:]+)(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?(?:\s+HDOP[:=](?<hdop>-?\d+(?:\.\d+)?))?/i;
const STARTUP_REGEX = /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*STARTUP:\s*(?<msg>.+)$/i;
const GPS_LOCK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*GPS:\s*LOCKED\s+Location[=:](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?)(?:\s+Satellites[=:](?<sats>\d+))?(?:\s+HDOP[=:](?<hdop>-?\d+(?:\.\d+)?))?/i;
const GPS_LOST_REGEX = /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*GPS:\s*LOST/i;
const NODE_HB_REGEX =
  /^\[NODE_HB\]\s*(?<id>[A-Za-z0-9_.:-]+)\s+Time:(?<time>[^ ]+)\s+Temp:(?<tempC>-?\d+(?:\.\d+)?)(?:[cCfF])?(?:\/(?<tempF>-?\d+(?:\.\d+)?)[fF])?(?:\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const NODE_HB_INLINE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):?\s*Time:(?<time>[^ ]+)\s+Temp:(?<tempC>-?\d+(?:\.\d+)?)(?:[cCfF])?(?:\/(?<tempF>-?\d+(?:\.\d+)?)[fF])?(?:\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;

const TARGET_REGEX_TYPE_FIRST =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*Target:\s*(?<type>\w+)\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)(?:\s+Name:(?<name>[^ ]+))?(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const TARGET_REGEX_MAC_FIRST =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*Target:\s*(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)\s+Type:(?<type>\w+)(?:\s+Name:(?<name>[^ ]+))?(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const TRI_TARGET_DATA_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?:TARGET_DATA|T_D):\s*(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)\s+Hits=(?<hits>\d+)\s+Type:(?<type>WiFi|BLE)(?:\s+GPS=(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?(?:\s+HDOP=(?<hdop>-?\d+(?:\.\d+)?))?(?:\s+TS=(?<ts>-?\d+(?:\.\d+)?))?/i;
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
const VIBRATION_STATUS_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*VIBRATION_STATUS:\s*(?<msg>.+)$/i;
const SETUP_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*SETUP_(?<kind>MODE|COMPLETE):\s*(?<msg>.+)$/i;
const TAMPER_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*TAMPER_(?<kind>DETECTED|CANCELLED):?(?:\s*(?<msg>.+))?/i;
const ERASE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ERASE_(?<kind>EXECUTING|ACK|CANCELLED|COMPLETE):(?<msg>.+)?/i;
const AUTOERASE_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*AUTOERASE_ACK:(?<status>ENABLED|DISABLED)(?:\s+Setup:(?<setup>\d+)s)?(?:\s+Erase:(?<erase>\d+)s)?(?:\s+Vibs:(?<vibs>\d+))?(?:\s+Window:(?<window>\d+)s)?(?:\s+Cooldown:(?<cooldown>\d+)s)?/i;
const AUTOERASE_STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*AUTOERASE_STATUS:\s*Enabled:(?<enabled>YES|NO)(?:\s+SetupMode:(?<setupMode>\S+))?(?:\s+TamperActive:(?<tamperActive>YES|NO))?(?:\s+Setup:(?<setup>\d+)s)?(?:\s+Erase:(?<erase>\d+)s)?(?:\s+Vibs:(?<vibs>\d+))?(?:\s+Window:(?<window>\d+)s)?(?:\s+Cooldown:(?<cooldown>\d+)s)?/i;
const BASELINE_STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*BASELINE_STATUS:\s*Scanning:(?<scanning>YES|NO)\s+Established:(?<est>YES|NO)\s+Devices:(?<dev>\d+)\s+Anomalies:(?<anom>\d+)\s+Phase1:(?<phase>[A-Z]+)/i;

const ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?<kind>(?:SCAN|DEVICE_SCAN|DRONE|DEAUTH|RANDOMIZATION|BASELINE|CONFIG|TRIANGULATE(?:_STOP)?|STOP|REBOOT)_ACK):(?<status>[A-Z_]+)/i;
const WIPE_TOKEN_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*WIPE_TOKEN:(?<token>[A-Za-z0-9_:-]+)/i;
const ERASE_TOKEN_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ERASE_TOKEN:(?<token>[A-Za-z0-9_:-]+|\w+)(?:\s+Time:(?<time>\d+)s)?/i;
// TRIANGULATE_ACK format: nodeId: TRIANGULATE_ACK:MAC:duration:originNodeId:rfEnvironment
// rfEnvironment values: 0=Open Sky, 1=Suburban, 2=Indoor, 3=Indoor Dense, 4=Industrial
const TRI_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_ACK:(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})(?::(?<duration>\d+))?(?::(?<originNode>[A-Za-z0-9_-]+))?(?::(?<rfEnv>[0-4]))?$/i;
const TRI_ACK_FALLBACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_ACK:(?<target>.+)$/i;
const TRI_STOP_ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_STOP_ACK/i;
const BASELINE_ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*BASELINE_ACK:(?<status>[A-Z_]+)/i;
const TRI_RESULTS_START_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_RESULTS_START/i;
const TRI_RESULTS_END_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_RESULTS_END/i;
const TRI_RESULTS_NO_DATA_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_RESULTS:NO_DATA/i;
// Matches echoed @ALL TRIANGULATE_START commands to ignore them
const TRI_START_ECHO_REGEX = /^@ALL\s+TRIANGULATE_START:/i;
const TRI_FINAL_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*T_F:\s*MAC=(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+GPS=(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?)\s+CONF=(?<conf>-?\d+(?:\.\d+)?)\s+UNC=(?<unc>-?\d+(?:\.\d+)?)/i;
const TRI_COMPLETE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*T_C:\s*(?:MAC=(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+)?Nodes=(?<nodes>\d+)\s*(?<rest>.+)?$/i;
const RTC_SYNC_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*RTC_SYNC:(?<source>\S+)/i;
const TIME_SYNC_REQ_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*TIME_SYNC_REQ:(?<time>\d+):(?<window>\d+):(?<seq>\d+):(?<offset>-?\d+)/i;
const TIME_SYNC_RESP_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*TIME_SYNC_RESP:(?<time>\d+):(?<window>\d+):(?<seq>\d+):(?<offset>-?\d+)/i;

const NODE_ID_FALLBACK = /^([A-Za-z0-9_.:-]+)/;

export class MeshtasticRewriteParser implements SerialProtocolParser {
  parseLine(rawLine: string): SerialParseResult[] {
    const sanitized = this.normalize(rawLine);
    if (!sanitized) return [];

    // Drop tiny ANSI fragments like "0m" to avoid contaminating the next line.
    if (sanitized.length <= 3 && /^[0m\s]*$/i.test(sanitized)) {
      return [];
    }

    // Check if this is a Meshtastic 2.6+/2.7+ Router/SerialConsole echo with msg= format
    const msgIndex = sanitized.lastIndexOf('msg=');
    const hasMsgSegment = msgIndex >= 0;
    // Meshtastic 2.6 uses "textmessage msg=...", 2.7+ uses "[Router] Received text msg ... msg=..."
    const isMeshtasticEcho =
      hasMsgSegment &&
      (/\[(Router|SerialConsole)\]/i.test(sanitized) ||
        /^textmessage\s+msg=/i.test(sanitized) ||
        /\btextmessage\s+msg=/i.test(sanitized)) &&
      (/Received text msg/i.test(sanitized) || /textmessage/i.test(sanitized));

    // Extract payload: for Mesh echoes, get text after msg=; otherwise use msg= content or full line
    let payloadRaw: string;
    if (isMeshtasticEcho) {
      // Extract everything after "msg=" for Meshtastic 2.6+/2.7 format
      payloadRaw = sanitized.slice(msgIndex + 4).trim();
    } else if (hasMsgSegment) {
      // Standard msg= format from other sources
      payloadRaw = sanitized.slice(msgIndex + 4).trim();
    } else {
      payloadRaw = sanitized;
    }
    const normalizedPayloadRaw = payloadRaw
      .replace(/\r?\n\s*Type:/g, ' Type:')
      .replace(/\r?\n\s*RSSI:/g, ' RSSI:')
      .replace(/\r?\n\s*GPS=/g, ' GPS=');
    const payload = this.stripTrailingHash(normalizedPayloadRaw.replace(/^0m\s*/i, ''));
    const sourceId = this.extractSourceId(sanitized);

    // Ignore echoed TRIANGULATE_START commands (sent by app, echoed back by mesh)
    if (TRI_START_ECHO_REGEX.test(payload) || TRI_START_ECHO_REGEX.test(sanitized)) {
      return [];
    }

    const parsed =
      this.parseTarget(payload, sourceId, sanitized) ||
      this.parseTriangulationTarget(payload, sourceId, sanitized) ||
      this.parseDevice(payload, sourceId, sanitized) ||
      this.parseDrone(payload, sourceId, sanitized) ||
      this.parseAnomaly(payload, sourceId, sanitized) ||
      this.parseAttack(payload, sourceId, sanitized) ||
      this.parseRandomization(payload, sourceId, sanitized) ||
      this.parseVibration(payload, sourceId, sanitized) ||
      this.parseTamper(payload, sourceId, sanitized) ||
      this.parseTriangulationMeta(payload, sourceId, sanitized) ||
      this.parseStatus(payload, sourceId, sanitized) ||
      this.parseTimeSync(payload, sourceId, sanitized) ||
      this.parseStartupGpsHeartbeat(payload, sourceId, sanitized) ||
      this.parseAck(payload, sourceId, sanitized);

    if (parsed) return parsed;

    // For unparsed lines, only emit as raw if not a Meshtastic echo
    // (Mesh echoes that don't parse are typically commands/noise, not data)
    return isMeshtasticEcho ? [] : [{ kind: 'raw', raw: sanitized }];
  }

  reset(): void {
    // stateless parser
  }

  private parseTarget(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = TARGET_REGEX_TYPE_FIRST.exec(payload) ?? TARGET_REGEX_MAC_FIRST.exec(payload);
    if (!m?.groups) return null;
    const sourceNode = nodeId ?? m.groups.id;
    const lat = m.groups.lat ? Number(m.groups.lat) : undefined;
    const lon = m.groups.lon ? Number(m.groups.lon) : undefined;
    const detected: SerialParseResult = {
      kind: 'target-detected',
      nodeId: sourceNode,
      mac: m.groups.mac.toUpperCase(),
      rssi: Number(m.groups.rssi),
      type: m.groups.type,
      name: m.groups.name,
      lat,
      lon,
      raw,
    };
    const alert: SerialParseResult = {
      kind: 'alert',
      level: 'NOTICE',
      category: 'inventory',
      nodeId: sourceNode,
      message: payload,
      raw,
      data: {
        mac: detected.mac,
        rssi: detected.rssi,
        type: detected.type,
        name: detected.name,
        lat,
        lon,
      },
    };
    return [detected, alert];
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

  private parseTriangulationTarget(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const match = TRI_TARGET_DATA_REGEX.exec(payload);
    if (!match?.groups) {
      return null;
    }
    const mac = match.groups.mac.toUpperCase();
    const hits = match.groups.hits ? Number(match.groups.hits) : undefined;
    const rssi = Number(match.groups.rssi);
    const type = match.groups.type;
    const lat = match.groups.lat ? Number(match.groups.lat) : undefined;
    const lon = match.groups.lon ? Number(match.groups.lon) : undefined;
    const hdop = match.groups.hdop ? Number(match.groups.hdop) : undefined;

    // TS provides centisecond precision timestamp from firmware
    const detectionTimestamp = match.groups.ts ? Number(match.groups.ts) * 1_000_000 : undefined;
    const resolvedNodeId = nodeId ?? match.groups.id;
    return [
      {
        kind: 'alert',
        level: 'NOTICE',
        category: 'triangulation',
        nodeId: resolvedNodeId,
        message: payload,
        raw,
        data: {
          mac,
          hits,
          rssi,
          type,
          lat,
          lon,
          hdop,
          detectionTimestamp,
        },
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
          level: 'INFO',
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
    const vibStatus = VIBRATION_STATUS_REGEX.exec(payload);
    if (vibStatus?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'vibration',
          nodeId: nodeId ?? vibStatus.groups.id,
          message: payload,
          data: {
            status: vibStatus.groups.msg?.trim(),
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
    const msgBase = payload;
    const msg = this.stripTrailingHash(msgBase);
    const normalizedLat = Number.isFinite(lat) ? (lat as number) : 0;
    const normalizedLon = Number.isFinite(lon) ? (lon as number) : 0;
    const results: SerialParseResult[] = [];
    // Only emit a single alert for STATUS messages (don't duplicate with telemetry)
    results.push({
      kind: 'alert',
      level: 'NOTICE',
      category: 'status',
      nodeId: resolvedNodeId,
      message: msg,
      raw,
      data: {
        hdop,
        lat: normalizedLat,
        lon: normalizedLon,
        temperatureC: m.groups.tempC ? Number(m.groups.tempC) : undefined,
        temperatureF: m.groups.tempF ? Number(m.groups.tempF) : undefined,
      },
    });
    // If firmware prefixes an alias (e.g., "ah02: AH902: STATUS ..."), normalize the raw payload
    // so downstream UI doesn't display the duplicate leading token.
    if (resolvedNodeId) {
      const normalizedRaw = payload.replace(/^[A-Za-z0-9_.:-]+:\s+([A-Za-z0-9_.:-]+:\s+)?/, '');
      results.forEach((entry) => {
        entry.raw = normalizedRaw;
      });
    }
    return results;
  }

  private parseStartupGpsHeartbeat(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const hb = NODE_HB_REGEX.exec(payload) ?? NODE_HB_INLINE_REGEX.exec(payload);
    if (hb?.groups) {
      const temperatureC = hb.groups.tempC ? Number(hb.groups.tempC) : undefined;
      const temperatureF = hb.groups.tempF ? Number(hb.groups.tempF) : undefined;
      const lat = hb.groups.lat ? Number(hb.groups.lat) : undefined;
      const lon = hb.groups.lon ? Number(hb.groups.lon) : undefined;
      const telemetry: SerialParseResult = {
        kind: 'node-telemetry',
        nodeId: nodeId ?? hb.groups.id,
        lat,
        lon,
        raw,
        lastMessage: payload,
        temperatureC,
        temperatureF,
      };
      return [
        telemetry,
        {
          kind: 'alert',
          level: 'INFO',
          category: 'heartbeat',
          nodeId: nodeId ?? hb.groups.id,
          message: payload,
          raw,
          data: {
            temperatureC,
            temperatureF,
            lat,
            lon,
          },
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
      const rfEnvLabels: Record<string, string> = {
        '0': 'Open Sky',
        '1': 'Suburban',
        '2': 'Indoor',
        '3': 'Indoor Dense',
        '4': 'Industrial',
      };
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? triAck.groups.id,
          ackType: 'TRIANGULATE_ACK',
          status: 'OK',
          raw,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: nodeId ?? triAck.groups.id,
          message: payload,
          raw,
          data: {
            mac: triAck.groups.mac?.toUpperCase(),
            duration: triAck.groups.duration ? Number(triAck.groups.duration) : undefined,
            originNode: triAck.groups.originNode,
            rfEnvironment: triAck.groups.rfEnv,
            rfEnvironmentLabel: triAck.groups.rfEnv ? rfEnvLabels[triAck.groups.rfEnv] : undefined,
          },
        },
      ];
    }
    // Fallback for older firmware or simpler ACK formats
    const triAckFallback = TRI_ACK_FALLBACK_REGEX.exec(payload);
    if (triAckFallback?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: nodeId ?? triAckFallback.groups.id,
          message: payload,
          raw,
          data: {
            target: triAckFallback.groups.target,
          },
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
    const eraseToken = ERASE_TOKEN_REGEX.exec(payload);
    if (eraseToken?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'erase',
          nodeId: nodeId ?? eraseToken.groups.id,
          message: payload,
          raw,
          data: {
            token: eraseToken.groups.token,
            time: eraseToken.groups.time ? Number(eraseToken.groups.time) : undefined,
          },
        },
      ];
    }
    const autoEraseAck = AUTOERASE_ACK_REGEX.exec(payload);
    if (autoEraseAck?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? autoEraseAck.groups.id,
          ackType: 'AUTOERASE_ACK',
          status: autoEraseAck.groups.status,
          raw,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'erase',
          nodeId: nodeId ?? autoEraseAck.groups.id,
          message: payload,
          raw,
          data: {
            status: autoEraseAck.groups.status,
            setupDelay: autoEraseAck.groups.setup ? Number(autoEraseAck.groups.setup) : undefined,
            eraseDelay: autoEraseAck.groups.erase ? Number(autoEraseAck.groups.erase) : undefined,
            vibrationsRequired: autoEraseAck.groups.vibs
              ? Number(autoEraseAck.groups.vibs)
              : undefined,
            detectionWindow: autoEraseAck.groups.window
              ? Number(autoEraseAck.groups.window)
              : undefined,
            autoEraseCooldown: autoEraseAck.groups.cooldown
              ? Number(autoEraseAck.groups.cooldown)
              : undefined,
          },
        },
      ];
    }
    const autoEraseStatus = AUTOERASE_STATUS_REGEX.exec(payload);
    if (autoEraseStatus?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? autoEraseStatus.groups.id,
          ackType: 'AUTOERASE_STATUS_ACK',
          status: 'OK',
          raw,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'erase',
          nodeId: nodeId ?? autoEraseStatus.groups.id,
          message: payload,
          raw,
          data: {
            enabled: autoEraseStatus.groups.enabled === 'YES',
            setupMode: autoEraseStatus.groups.setupMode,
            tamperActive: autoEraseStatus.groups.tamperActive === 'YES',
            setupDelay: autoEraseStatus.groups.setup
              ? Number(autoEraseStatus.groups.setup)
              : undefined,
            eraseDelay: autoEraseStatus.groups.erase
              ? Number(autoEraseStatus.groups.erase)
              : undefined,
            vibrationsRequired: autoEraseStatus.groups.vibs
              ? Number(autoEraseStatus.groups.vibs)
              : undefined,
            detectionWindow: autoEraseStatus.groups.window
              ? Number(autoEraseStatus.groups.window)
              : undefined,
            autoEraseCooldown: autoEraseStatus.groups.cooldown
              ? Number(autoEraseStatus.groups.cooldown)
              : undefined,
          },
        },
      ];
    }
    return null;
  }

  private parseTriangulationMeta(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const id = nodeId ?? this.extractNodeId(payload, undefined);
    if (TRI_RESULTS_START_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: { stage: 'results-start' },
        },
      ];
    }
    if (TRI_RESULTS_END_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: { stage: 'results-end' },
        },
      ];
    }
    if (TRI_RESULTS_NO_DATA_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: { stage: 'no-data' },
        },
      ];
    }
    const final = TRI_FINAL_REGEX.exec(payload);
    if (final?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: {
            stage: 'final',
            mac: final.groups.mac.toUpperCase(),
            lat: Number(final.groups.lat),
            lon: Number(final.groups.lon),
            confidence: Number(final.groups.conf),
            uncertainty: Number(final.groups.unc),
          },
        },
      ];
    }
    const complete = TRI_COMPLETE_REGEX.exec(payload);
    if (complete?.groups) {
      const nodes = complete.groups.nodes ? Number(complete.groups.nodes) : undefined;
      const { lat, lon } = this.extractLatLonFromText(complete.groups.rest);
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: {
            stage: 'complete',
            nodes,
            mac: complete.groups.mac?.toUpperCase(),
            lat,
            lon,
            link: complete.groups.rest?.trim(),
          },
        },
      ];
    }
    return null;
  }

  private parseTimeSync(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const rtc = RTC_SYNC_REGEX.exec(payload);
    if (rtc?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'time-sync',
          nodeId: nodeId ?? rtc.groups.id,
          message: payload,
          raw,
          data: {
            mode: 'rtc',
            source: rtc.groups.source,
          },
        },
      ];
    }
    const req = TIME_SYNC_REQ_REGEX.exec(payload);
    if (req?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'time-sync',
          nodeId: nodeId ?? req.groups.id,
          message: payload,
          raw,
          data: {
            mode: 'request',
            time: Number(req.groups.time),
            window: Number(req.groups.window),
            sequence: Number(req.groups.seq),
            offset: Number(req.groups.offset),
          },
        },
      ];
    }
    const resp = TIME_SYNC_RESP_REGEX.exec(payload);
    if (resp?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'time-sync',
          nodeId: nodeId ?? resp.groups.id,
          message: payload,
          raw,
          data: {
            mode: 'response',
            time: Number(resp.groups.time),
            window: Number(resp.groups.window),
            sequence: Number(resp.groups.seq),
            offset: Number(resp.groups.offset),
          },
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

  private extractLatLonFromText(text?: string | null): { lat?: number; lon?: number } {
    if (!text) {
      return {};
    }
    const match =
      /q=([-0-9.]+),([-0-9.]+)/i.exec(text) ?? /GPS[:=]([-0-9.]+),([-0-9.]+)/i.exec(text);
    if (!match) {
      return {};
    }
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {};
    }
    return { lat, lon };
  }

  private normalizeBand(band?: string): string | undefined {
    if (!band) return undefined;
    const b = band.toUpperCase();
    if (b === 'W') return 'WiFi';
    if (b === 'B') return 'BLE';
    return b;
  }
}
