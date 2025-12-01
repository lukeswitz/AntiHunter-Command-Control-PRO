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

function createAircraft(index) {
  const { dep, dest } = randomDepDest();
  const baseTrack = Math.random() * 360;

  // Use sample registration if available, otherwise generate random
  const sample = sampleRegistrations[index] ?? null;
  const reg = sample?.reg ?? null;
  const flight = sample?.flight ?? randomCallsign();

  return {
    hex: randomHex(),
    flight,
    reg,
    lat: null,
    lon: null,
    alt_geom: Math.floor(2500 + Math.random() * 12000),
    gs: Math.floor(120 + Math.random() * 320),
    track: baseTrack,
    seen: 0,
    category: ['A1', 'A2', 'B7', 'C1', 'A5'][index % 5],
    dep,
    dest,
    _drift: (Math.random() - 0.5) * 1.5,
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
    // slight altitude wiggle
    a.alt_geom = Math.max(500, a.alt_geom + Math.floor((Math.random() - 0.5) * 200));
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
  res.end(
    [
      'ADS-B simulator running.',
      `Serving dump1090-style JSON at http://localhost:${options.port}/data/aircraft.json`,
      `Aircraft: ${state.aircraft.length}, interval: ${options.interval}ms.`,
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
