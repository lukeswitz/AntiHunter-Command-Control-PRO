import { MeshtasticRewriteParser } from '../apps/backend/src/serial/protocols/meshtastic-rewrite.parser';

const parser = new MeshtasticRewriteParser();
const lines = [
  'AH3 Status Mode:WiFi+BLE Scan:IDLE Hits:0 Unique:0 Temp:45.0C/undefinedF Up:01:08:01 AH3 GPS 0.000000 deg N, 0.000000 deg E',
  'AH3 GPS:0.000000, 0.000000',
];

for (const line of lines) {
  const events = parser.parseLine(line);
  console.log('LINE:', line);
  console.dir(events, { depth: null });
}
