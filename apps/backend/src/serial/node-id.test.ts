import assert from 'node:assert/strict';

import { MeshtasticRewriteParser } from './protocols/meshtastic-rewrite.parser';

const LINES = [
  'AH12: STATUS: Mode:WiFi Scan:IDLE Hits:1 Temp:30.0C Up:00:00:01',
  'AH12 STATUS: Mode:WiFi Scan:IDLE Hits:1 Temp:30.0C Up:00:00:01',
  'AH12: STARTUP: boot',
  'AH12: GPS: LOCKED Location=1.5,2.5',
  'AH12: GPS: LOST',
  'AH12: Time:2026-01-01_00:00:00 Temp:30.0C GPS:1.5,2.5',
  '[NODE_HB] AH12 Time:x Temp:30C',
  'AH12: VIBRATION_STATUS: none',
  'AH12: Target: WiFi AA:BB:CC:DD:EE:FF RSSI:-50',
];

const parser = new MeshtasticRewriteParser();
let failed = 0;
for (const line of LINES) {
  const ids = [
    ...new Set(
      parser
        .parseLine(line)
        .map((event) => (event as { nodeId?: string }).nodeId)
        .filter(Boolean),
    ),
  ];
  try {
    assert.deepEqual(ids, ['AH12'], line);
    console.log(`  PASS ${line}`);
  } catch {
    failed += 1;
    console.log(`  FAIL ${line} -> ${JSON.stringify(ids)}`);
  }
}
console.log(`\n${LINES.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
