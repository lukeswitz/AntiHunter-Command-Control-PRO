#!/usr/bin/env node

/**
 * Triangulation Simulator - Tests firmware-based RSSI triangulation
 *
 * Simulates 4 static nodes detecting a single STATIC target (MAC: AA:BB:CC:DD:EE:FF)
 * positioned inside the node constellation. Each detection includes RSSI values
 * calculated from distance-based path loss. Triangulation is performed in firmware,
 * which sends T_F (final) messages with the calculated position.
 *
 * Usage: node scripts/tdoa-sim.cjs --token "<YOUR_ADMIN_JWT>"
 *
 * Options:
 *   --token <jwt>   Admin JWT token (REQUIRED)
 *   --nodes <n>     Number of nodes (3-5, default: 4)
 *   --interval <ms> Detection interval (default: 3000)
 *   --count <n>     Number of detections (default: 20)
 *
 * To get a token:
 *   1. Start backend: pnpm --filter @command-center/backend dev
 *   2. Login: curl -X POST http://localhost:3000/api/auth/login \
 *        -H "Content-Type: application/json" \
 *        -d '{"email":"admin@example.com","password":"admin"}'
 *   3. Copy the accessToken from the response
 */

const http = require('http');

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? parseInt(args[i + 1]) : def;
};
const getStringArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const token = getStringArg('--token', '');
const nodeCount = getArg('--nodes', 4);
const interval = getArg('--interval', 3000);
const count = getArg('--count', 20);

const TARGET_MAC = 'AA:BB:CC:DD:EE:FF';

const NODES = [
  { id: 'AH01', lat: 37.7749, lon: -122.4194 },
  { id: 'AH02', lat: 37.7849, lon: -122.4094 },
  { id: 'AH03', lat: 37.7749, lon: -122.4094 },
  { id: 'AH04', lat: 37.7649, lon: -122.4144 },
  { id: 'AH05', lat: 37.7799, lon: -122.4244 },
].slice(0, Math.max(3, Math.min(5, nodeCount)));

const targetLat = 37.7774;
const targetLon = -122.4144;

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function send(lines) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ lines });
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };

    if (token) {
      headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }

    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path: '/api/serial/simulate',
        method: 'POST',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          } else {
            resolve(body);
          }
        });
      },
    );

    req.on('error', (err) => {
      reject(new Error(`Connection failed: ${err.message}. Is the backend running on port 3000?`));
    });
    req.write(data);
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!token) {
    console.error('\nError: --token is required\n');
    console.log('To get an admin JWT token:');
    console.log('  1. Start backend: pnpm --filter @command-center/backend dev');
    console.log('  2. Login to get token:');
    console.log('     curl -X POST http://localhost:3000/api/auth/login \\');
    console.log('       -H "Content-Type: application/json" \\');
    console.log('       -d \'{"email":"admin@example.com","password":"admin"}\'');
    console.log('  3. Copy the accessToken from the response');
    console.log('  4. Run: node scripts/tdoa-sim.cjs --token "YOUR_TOKEN"\n');
    process.exit(1);
  }

  console.log(`\nTriangulation Simulator (RSSI-based)`);
  console.log(`   Nodes: ${NODES.length}`);
  console.log(`   Interval: ${interval}ms`);
  console.log(`   Detections: ${count}\n`);

  for (const node of NODES) {
    await send([
      `${node.id}: STATUS: Mode:WiFi+BLE Scan:Active Hits:0 Targets:0 Temp:25.0C Up:00:00:01 GPS=${node.lat.toFixed(6)},${node.lon.toFixed(6)} HDOP=0.9`,
      `${node.id}: GPS:LOCKED Location=${node.lat.toFixed(6)},${node.lon.toFixed(6)} Satellites=12 HDOP=0.9`,
    ]);
  }

  console.log('Nodes registered');
  console.log(`Static Target: ${targetLat.toFixed(6)}, ${targetLon.toFixed(6)}`);
  console.log(`   MAC: ${TARGET_MAC}\n`);
  await delay(2000);

  console.log('Creating target in database...');
  const initialDetections = [];
  for (const node of NODES) {
    const dist = distance(targetLat, targetLon, node.lat, node.lon);
    const rssi = Math.round(-65 - 20 * Math.log10(dist / 100));
    initialDetections.push(
      `${node.id}: Target: WiFi ${TARGET_MAC} RSSI:${rssi}`,
    );
  }
  await send(initialDetections);
  console.log(`  ✓ Target created from ${NODES.length} initial detections\n`);
  await delay(2000);

  console.log('Starting RSSI-based triangulation scan...\n');

  for (let i = 0; i < count; i++) {
    const lines = [];

    console.log(`[${i + 1}/${count}] Detection Round ${i + 1}`);

    for (const node of NODES) {
      const dist = distance(targetLat, targetLon, node.lat, node.lon);
      const rssi = Math.round(-65 - 20 * Math.log10(dist / 100));

      lines.push(
        `${node.id}: T_D: ${TARGET_MAC} RSSI:${rssi} Hits=2 Type:WiFi GPS=${node.lat.toFixed(6)},${node.lon.toFixed(6)} HDOP=0.9`,
      );

      console.log(
        `  ${node.id}: dist=${dist.toFixed(1)}m, RSSI=${rssi}dBm`,
      );
    }

    await send(lines);
    console.log(`  ✓ Sent\n`);

    if (i < count - 1) await delay(interval);
  }

  // Send triangulation completion messages from the primary node
  console.log('Sending triangulation results...');
  const finalLat = targetLat.toFixed(6);
  const finalLon = targetLon.toFixed(6);
  const endLines = [];

  const primaryNode = NODES[0];
  endLines.push(
    `${primaryNode.id}: T_F: MAC=${TARGET_MAC} GPS=${finalLat},${finalLon} CONF=85.5 UNC=12.3`,
  );
  endLines.push(
    `${primaryNode.id}: T_C: MAC=${TARGET_MAC} Nodes=${NODES.length} https://www.google.com/maps?q=${finalLat},${finalLon}`,
  );

  await send(endLines);

  console.log(`Done! Check your C2 map`);
  console.log(`   Expected location: ${finalLat}, ${finalLon}`);
  console.log(`   https://www.google.com/maps?q=${finalLat},${finalLon}\n`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});