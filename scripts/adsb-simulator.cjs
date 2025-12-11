#!/usr/bin/env node
/**
 * Lightweight ADS-B feed simulator for local testing.
 *
 * Serves a dump1090/readsb-style aircraft.json at /data/aircraft.json
 * and sends ACARS messages via UDP for correlation testing.
 *
 * Options (env or CLI flags):
 *   --port / PORT              HTTP port (default 8090)
 *   --count / COUNT            Number of aircraft to simulate (default 8)
 *   --interval / INTERVAL      Update interval in ms (default 1500)
 *   --lat / LAT                Center latitude (default 63.43)
 *   --lon / LON                Center longitude (default 10.39)
 *   --radius / RADIUS          Max offset from center in km (default 30)
 *   --acars-host / ACARS_HOST  ACARS UDP host (default 127.0.0.1)
 *   --acars-port / ACARS_PORT  ACARS UDP port (default 15550)
 *
 * First 5 aircraft have registrations for ACARS correlation testing.
 * ACARS messages are sent every 10 seconds matching aircraft tail numbers.
 */

const http = require('http');
const dgram = require('dgram');

function parseArgs() {
  const args = process.argv.slice(2);
  const lookup = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const next = args[i + 1];
    if (key?.startsWith('--')) {
      lookup.set(key.replace(/^--/, ''), next ?? 'true');
    }
  }
  const get = (key, envKey, fallback) => {
    const val = lookup.get(key) ?? process.env[envKey];
    if (val === undefined) return fallback;
    const asNum = Number(val);
    return Number.isFinite(asNum) ? asNum : val;
  };
  return {
    port: get('port', 'PORT', 8090),
    count: get('count', 'COUNT', 8),
    interval: get('interval', 'INTERVAL', 1500),
    lat: get('lat', 'LAT', 63.43),
    lon: get('lon', 'LON', 10.39),
    radiusKm: get('radius', 'RADIUS', 30),
    acarsPort: get('acars-port', 'ACARS_PORT', 15550),
    acarsHost: get('acars-host', 'ACARS_HOST', '127.0.0.1'),
  };
}

const options = parseArgs();

function randomHex(length = 6) {
  const chars = '0123456789ABCDEF';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Generate ICAO hex code based on aircraft type.
 * US Military: AE0000-AEFFFF
 * US Civilian: A00000-ADFFFF (approximation)
 */
function generateIcaoHex(category, isMilitary = false) {
  if (isMilitary || category === 'A6') {
    // US Military range: AE0000-AEFFFF
    const min = 0xAE0000;
    const max = 0xAEFFFF;
    const hex = Math.floor(Math.random() * (max - min + 1)) + min;
    return hex.toString(16).toUpperCase().padStart(6, '0');
  }

  // US Civilian range: A00000-ADFFFF
  const min = 0xA00000;
  const max = 0xADFFFF;
  const hex = Math.floor(Math.random() * (max - min + 1)) + min;
  return hex.toString(16).toUpperCase().padStart(6, '0');
}

const AIRCRAFT_TYPES = [
  // Regular planes (A1-A4)
  { category: 'A1', callsign: 'N172CP', type: 'C172', description: 'Light aircraft', altRange: [2000, 8000], speedRange: [90, 130], isMilitary: false },
  { category: 'A2', callsign: 'SKW789', type: 'CRJ7', description: 'Small commercial', altRange: [25000, 30000], speedRange: [350, 400], isMilitary: false },
  { category: 'A3', callsign: 'UAL123', type: 'B738', description: 'Large commercial', altRange: [30000, 38000], speedRange: [420, 480], isMilitary: false },
  { category: 'A4', callsign: 'DAL456', type: 'A321', description: 'Large commercial', altRange: [30000, 38000], speedRange: [420, 480], isMilitary: false },
  // Heavy aircraft (A5)
  { category: 'A5', callsign: 'QFA12', type: 'A380', description: 'Heavy aircraft (>300,000 lbs)', altRange: [35000, 41000], speedRange: [460, 510], isMilitary: false },
  { category: 'A5', callsign: 'BAW101', type: 'B77W', description: 'Heavy aircraft (>300,000 lbs)', altRange: [35000, 41000], speedRange: [460, 510], isMilitary: false },
  // High performance / Fighter (A6) - MILITARY
  { category: 'A6', callsign: 'VIPER01', type: 'F16', description: 'High performance military', altRange: [15000, 25000], speedRange: [400, 600], isMilitary: true },
  { category: 'A6', callsign: 'RAPTOR', type: 'F22', description: 'High performance military', altRange: [15000, 30000], speedRange: [400, 700], isMilitary: true },
  // Helicopters (A7)
  { category: 'A7', callsign: 'LIFE1', type: 'H60', description: 'Rotorcraft', altRange: [500, 2000], speedRange: [100, 160], isMilitary: false },
  { category: 'A7', callsign: 'ARMY23', type: 'AH64', description: 'Military rotorcraft', altRange: [300, 1500], speedRange: [100, 180], isMilitary: true },
  // Military transports with callsigns
  { category: 'A5', callsign: 'RCH123', type: 'C17', description: 'Heavy military transport', altRange: [28000, 35000], speedRange: [400, 460], isMilitary: true },
  { category: 'A3', callsign: 'REACH45', type: 'C130', description: 'Military transport', altRange: [20000, 28000], speedRange: [300, 360], isMilitary: true },
  // Gliders (B1)
  { category: 'B1', callsign: 'GLIDE3', type: 'ASW20', description: 'Glider/Sailplane', altRange: [3000, 12000], speedRange: [50, 90], isMilitary: false },
  // Balloons (B2)
  { category: 'B2', callsign: 'BALLN1', type: 'BALL', description: 'Balloon/Airship', altRange: [2000, 8000], speedRange: [5, 25], isMilitary: false },
  // UAVs/Drones (B6) - Can be military
  { category: 'B6', callsign: 'DRONE1', type: 'MQ9', description: 'Unmanned aerial system', altRange: [8000, 15000], speedRange: [120, 200], isMilitary: true },
  { category: 'B6', callsign: 'PRED01', type: 'MQ1', description: 'Unmanned aerial system', altRange: [8000, 15000], speedRange: [100, 180], isMilitary: true },
  // Ground vehicles (C1)
  { category: 'C1', callsign: 'TRUCK5', type: 'GRND', description: 'Ground vehicle - emergency', altRange: [0, 0], speedRange: [10, 40], isMilitary: false },
];

function randomCallsign() {
  const prefixes = ['SAS', 'KLM', 'DLH', 'BAW', 'NAX', 'RYR', 'UAL', 'AAL', 'QTR', 'UAE'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const number = String(Math.floor(Math.random() * 900) + 100);
  return `${prefix}${number}`;
}

function randomDepDest() {
  const airports = ['OSL', 'TRD', 'SVG', 'BGO', 'CPH', 'ARN', 'LGW', 'AMS', 'FRA', 'CDG'];
  const dep = airports[Math.floor(Math.random() * airports.length)];
  let dest = airports[Math.floor(Math.random() * airports.length)];
  if (dest === dep) {
    dest = airports[(airports.indexOf(dep) + 3) % airports.length];
  }
  return { dep, dest };
}

function randomOffset(base, radiusKm) {
  // crude equirectangular offset for short distances
  const angle = Math.random() * Math.PI * 2;
  const distKm = Math.random() * radiusKm;
  const dLat = (distKm / 110.574) * Math.cos(angle);
  const dLon = (distKm / (111.320 * Math.cos((base.lat * Math.PI) / 180))) * Math.sin(angle);
  return { lat: base.lat + dLat, lon: base.lon + dLon };
}

// Sample aircraft registrations for ACARS correlation testing
const sampleRegistrations = [
  { reg: 'N12345', flight: 'UAL123' },
  { reg: 'N789AB', flight: 'AAL456' },
  { reg: 'N456XY', flight: 'DAL789' },
  { reg: 'G-ABCD', flight: 'BAW101' },
  { reg: 'N999ZZ', flight: 'SWA202' },
];

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Get unique categories first, then fill randomly
function getShuffledTypes(count) {
  const byCategory = new Map();
  AIRCRAFT_TYPES.forEach((t) => {
    if (!byCategory.has(t.category)) byCategory.set(t.category, []);
    byCategory.get(t.category).push(t);
  });

  const result = [];
  // One from each category first
  for (const types of byCategory.values()) {
    result.push(types[Math.floor(Math.random() * types.length)]);
  }
  // Fill remaining slots randomly
  while (result.length < count) {
    result.push(AIRCRAFT_TYPES[Math.floor(Math.random() * AIRCRAFT_TYPES.length)]);
  }
  return shuffleArray(result).slice(0, count);
}

const shuffledTypes = getShuffledTypes(options.count);

function createAircraft(index) {
  const { dep, dest } = randomDepDest();
  const baseTrack = Math.random() * 360;

  const aircraftType = shuffledTypes[index] ?? AIRCRAFT_TYPES[Math.floor(Math.random() * AIRCRAFT_TYPES.length)];

  const [minAlt, maxAlt] = aircraftType.altRange;
  const [minSpeed, maxSpeed] = aircraftType.speedRange;
  const alt = Math.floor(minAlt + Math.random() * (maxAlt - minAlt));
  const speed = Math.floor(minSpeed + Math.random() * (maxSpeed - minSpeed));

  const sample = sampleRegistrations[index] ?? null;
  const reg = sample?.reg ?? null;
  const flight = sample?.flight ?? aircraftType.callsign + Math.floor(Math.random() * 100);

  return {
    hex: generateIcaoHex(aircraftType.category, aircraftType.isMilitary),
    flight,
    reg,
    lat: null,
    lon: null,
    alt_geom: alt,
    gs: speed,
    track: baseTrack,
    seen: 0,
    category: aircraftType.category,
    categoryDescription: aircraftType.description,
    aircraftType: aircraftType.type,
    typeCode: aircraftType.type,
    dep: aircraftType.category.startsWith('A') && !['A6', 'A7'].includes(aircraftType.category) ? dep : null,
    dest: aircraftType.category.startsWith('A') && !['A6', 'A7'].includes(aircraftType.category) ? dest : null,
    _drift: (Math.random() - 0.5) * 1.5,
    _altRange: aircraftType.altRange,
    _isMilitary: aircraftType.isMilitary,
  };
}

const state = {
  aircraft: Array.from({ length: options.count }, (_, idx) => {
    const a = createAircraft(idx);
    const { lat, lon } = randomOffset({ lat: options.lat, lon: options.lon }, options.radiusKm);
    a.lat = lat;
    a.lon = lon;
    return a;
  }),
  messages: 0,
  now: Math.floor(Date.now() / 1000),
};

function step() {
  state.now = Math.floor(Date.now() / 1000);
  state.aircraft.forEach((a) => {
    a.seen = Math.min((a.seen ?? 0) + options.interval / 1000, 5);
    a.track = (a.track + a._drift + (Math.random() - 0.5) * 0.8 + 360) % 360;
    const moveKm = (a.gs / 3600) * (options.interval / 1000); // distance traveled this tick
    const headingRad = (a.track * Math.PI) / 180;
    const dLat = (moveKm / 110.574) * Math.cos(headingRad);
    const dLon = (moveKm / (111.320 * Math.cos((a.lat * Math.PI) / 180))) * Math.sin(headingRad);
    a.lat += dLat;
    a.lon += dLon;
    // slight altitude wiggle within type's range
    const [minAlt, maxAlt] = a._altRange || [500, 40000];
    const altChange = Math.floor((Math.random() - 0.5) * 200);
    a.alt_geom = Math.max(minAlt, Math.min(maxAlt, a.alt_geom + altChange));
    state.messages += 1;
  });
}

setInterval(step, options.interval);

// ACARS message simulation
const acarsLabels = ['H1', 'Q0', '_d', '5Z', '80', 'H2', '5U', '44'];
const acarsMessages = [
  'REQUESTING CLEARANCE FOR DESCENT',
  'ENGINE PARAMETERS NORMAL',
  'FUEL REMAINING 12000 LBS',
  'ETA 1430Z',
  'ALTITUDE 35000 FT',
  'TURBULENCE LIGHT',
];

const udpClient = dgram.createSocket('udp4');

function sendAcarsMessages() {
  const numMessages = Math.floor(Math.random() * 2) + 1;
  const messages = [];

  for (let i = 0; i < numMessages; i++) {
    const aircraft = state.aircraft.filter((a) => a.reg);
    if (aircraft.length === 0) continue;

    const ac = aircraft[Math.floor(Math.random() * aircraft.length)];
    const timestamp = Math.floor(Date.now() / 1000);

    messages.push({
      timestamp,
      station_id: 'TEST-STN',
      channel: 0,
      freq: Number((131.45 + Math.random() * 0.5).toFixed(3)),
      level: Number((-15 + Math.random() * 10).toFixed(1)),
      noise: Number((-35 + Math.random() * 5).toFixed(1)),
      error: 0,
      mode: '2',
      label: acarsLabels[Math.floor(Math.random() * acarsLabels.length)],
      block_id: String.fromCharCode(65 + Math.floor(Math.random() * 26)),
      ack: false,
      tail: ac.reg,
      flight: ac.flight,
      msgno: String(Math.floor(Math.random() * 100)).padStart(3, '0'),
      text: acarsMessages[Math.floor(Math.random() * acarsMessages.length)],
      app: { name: 'adsb-simulator', ver: '1.0' },
    });
  }

  if (messages.length > 0) {
    const payload = JSON.stringify({ messages }, null, 2);
    const buffer = Buffer.from(payload);

    udpClient.send(buffer, 0, buffer.length, options.acarsPort, options.acarsHost, (err) => {
      if (err) {
        console.error(`[acars] Error: ${err.message}`);
      } else {
        console.log(
          `[acars] Sent ${messages.length} message(s) to ${options.acarsHost}:${options.acarsPort}`,
        );
        messages.forEach((msg) => {
          console.log(`  → ${msg.tail} [${msg.label}] ${msg.text.substring(0, 40)}...`);
        });
      }
    });
  }
}

setInterval(sendAcarsMessages, 10000);
setTimeout(sendAcarsMessages, 2000);

const server = http.createServer((req, res) => {
  if (req.url && req.url.includes('/data/aircraft.json')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const payload = {
      now: state.now,
      messages: state.messages,
      aircraft: state.aircraft.map((a) => ({
        hex: a.hex,
        flight: a.flight,
        reg: a.reg,
        lat: a.lat,
        lon: a.lon,
        alt_geom: a.alt_geom,
        gs: a.gs,
        track: a.track,
        seen: a.seen,
        category: a.category,
        categoryDescription: a.categoryDescription,
        aircraftType: a.aircraftType,
        typeCode: a.typeCode,
        dep: a.dep,
        dest: a.dest,
      })),
    };
    res.write(JSON.stringify(payload, null, 2));
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const categoryCounts = state.aircraft.reduce((acc, a) => {
    acc[a.category] = (acc[a.category] || 0) + 1;
    return acc;
  }, {});
  const categoryLabels = {
    A1: 'Light aircraft', A2: 'Small commercial', A3: 'Large commercial', A4: 'Large commercial',
    A5: 'Heavy aircraft', A6: 'High performance/Fighter', A7: 'Helicopter',
    B1: 'Glider', B2: 'Balloon', B6: 'UAV/Drone', C1: 'Ground vehicle'
  };
  const breakdown = Object.entries(categoryCounts)
    .map(([cat, count]) => `  ${cat} (${categoryLabels[cat]}): ${count}`)
    .join('\n');
  res.end(
    [
      'ADS-B simulator running with ALL aircraft types!',
      '',
      `Serving dump1090-style JSON at http://localhost:${options.port}/data/aircraft.json`,
      `Total aircraft: ${state.aircraft.length}, interval: ${options.interval}ms`,
      '',
      'Aircraft breakdown (ADS-B DO-260B categories):',
      breakdown,
      '',
      'Categories showcase:',
      '  ✈️  A1-A4: Commercial aircraft (light to large)',
      '  ✈️  A5: Heavy aircraft (A380, 747, 777)',
      '  ⚡ A6: High performance / Military fighters',
      '  🚁 A7: Helicopters / Rotorcraft',
      '  🪂 B1: Gliders / Sailplanes',
      '  🎈 B2: Balloons / Airships',
      '  🛸 B6: UAVs / Drones (anti-drone system)',
      '  🚗 C1: Ground vehicles',
    ].join('\n'),
  );
});

server.listen(options.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[adsb-simulator] Listening on http://localhost:${options.port} (count=${state.aircraft.length}, interval=${options.interval}ms)`,
  );
  console.log(
    `[acars] Will send messages to ${options.acarsHost}:${options.acarsPort} every 10s`,
  );
  console.log(
    `[acars] Aircraft with registrations: ${state.aircraft.filter((a) => a.reg).map((a) => a.reg).join(', ')}`,
  );
});
