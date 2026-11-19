import assert from 'node:assert/strict';

import { MeshtasticRewriteParser } from './protocols/meshtastic-rewrite.parser';
import type { SerialAlertEvent, SerialParseResult } from './serial.types';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

function only<K extends SerialParseResult['kind']>(
  results: SerialParseResult[],
  kind: K,
): Extract<SerialParseResult, { kind: K }> {
  const found = results.filter((r) => r.kind === kind);
  assert.equal(found.length, 1, `expected one ${kind}, got ${results.map((r) => r.kind)}`);
  return found[0] as Extract<SerialParseResult, { kind: K }>;
}

function credited(results: SerialParseResult[]): Array<string | undefined> {
  return results.map((r) => ('nodeId' in r ? r.nodeId : undefined));
}

test('FLEET_CMD relayed command becomes a structured coordination alert', () => {
  const parser = new MeshtasticRewriteParser();
  const results = parser.parseLine('AH3: FLEET_CMD:AH1-1a2b:2:@AH7 SCAN_START:2:60');
  const alert = only(results, 'alert') as SerialAlertEvent;
  assert.equal(alert.category, 'mesh-coordination');
  assert.equal(alert.nodeId, 'AH3');
  assert.deepEqual(alert.data, {
    coordinationType: 'FLEET_CMD',
    relayer: 'AH3',
    tag: 'AH1-1a2b',
    origin: 'AH1',
    hops: 2,
    target: 'AH7',
    command: 'SCAN_START:2:60',
  });
});

test('FLEET_CMD with an empty origin, target ALL and a colon-heavy command', () => {
  const parser = new MeshtasticRewriteParser();
  const alert = only(
    parser.parseLine('AH3: FLEET_CMD:-0F9E:1:@ALL TRIANGULATE_START:AA:BB:CC:DD:EE:FF:300:AH1:2'),
    'alert',
  ) as SerialAlertEvent;
  assert.equal(alert.nodeId, 'AH3');
  assert.deepEqual(alert.data, {
    coordinationType: 'FLEET_CMD',
    relayer: 'AH3',
    tag: '-0F9E',
    origin: undefined,
    hops: 1,
    target: 'ALL',
    command: 'TRIANGULATE_START:AA:BB:CC:DD:EE:FF:300:AH1:2',
  });
});

test('FLEET_CMD accepts the highest hop count', () => {
  const parser = new MeshtasticRewriteParser();
  const alert = only(
    parser.parseLine('AH3: FLEET_CMD:AH1-ffff:3:@AH9 STATUS'),
    'alert',
  ) as SerialAlertEvent;
  assert.equal((alert.data as Record<string, unknown>).hops, 3);
  assert.equal((alert.data as Record<string, unknown>).command, 'STATUS');
});

test('relayed replies are credited to the original node, not the relayer', () => {
  const parser = new MeshtasticRewriteParser();
  const cases: Array<[string, SerialParseResult['kind'][]]> = [
    [
      'AH3: AH7: STATUS: Mode:WiFi+BLE Scan:IDLE Hits:0 Temp:41.5C Up:00:12:03 GPS:12.5,-54.5 HDOP=1.0',
      ['node-telemetry', 'command-result'],
    ],
    ['AH3: AH7: STOP_ACK', ['command-ack']],
    ['AH3: AH7: DEVICE_SCAN_ACK:STARTED', ['command-ack']],
    ['AH3: AH7: SCAN_ACK:STARTED', ['command-ack']],
    ['AH3: AH7: SCHED_ACK:OK', ['command-ack']],
    ['AH3: AH7: SCHED_LIST:2', ['command-result']],
    ['AH3: AH7: CAMPAIGN_ACK:START:site-a', ['command-ack']],
    ['AH3: AH7: CAMPAIGN_STATUS:site-a', ['command-result']],
    ['AH3: AH7: CONFIG_ACK:BLE_CLASSIFY:1', ['command-ack']],
    ['AH3: AH7: CALIBRATE_ACK:STARTED', ['command-ack']],
  ];
  for (const [line, kinds] of cases) {
    const results = parser.parseLine(line);
    assert.deepEqual(
      results.map((r) => r.kind),
      kinds,
      line,
    );
    assert.deepEqual(
      credited(results),
      kinds.map(() => 'AH7'),
      line,
    );
  }
});

test('relayed STATUS keeps the position and ack type of the original node', () => {
  const parser = new MeshtasticRewriteParser();
  const status = parser.parseLine(
    'AH3: AH7: STATUS: Mode:WiFi Scan:IDLE Hits:0 Temp:25.0C Up:00:05:00 GPS:12.5,-54.5 HDOP=1.0',
  );
  const telemetry = only(status, 'node-telemetry');
  assert.equal(telemetry.nodeId, 'AH7');
  assert.equal(telemetry.lat, 12.5);
  const ack = only(parser.parseLine('AH3: AH7: CONFIG_ACK:BLE_CLASSIFY:1'), 'command-ack');
  assert.equal(ack.ackType, 'BLE_CLASSIFY_ACK');
  assert.equal(ack.nodeId, 'AH7');
});

test('direct replies and keyword second tokens are not treated as relays', () => {
  const parser = new MeshtasticRewriteParser();
  assert.deepEqual(credited(parser.parseLine('AH7: STOP_ACK')), ['AH7']);
  assert.deepEqual(credited(parser.parseLine('AH5: GPS: LOCKED Satellites:9 HDOP:1.60')), ['AH5']);
  assert.deepEqual(credited(parser.parseLine('AH5: Target: WiFi AA:BB:CC:DD:EE:FF RSSI:-72')), [
    'AH5',
    'AH5',
  ]);
});

test('FLEET_WHAT query is a coordination alert and not a status or ack', () => {
  const parser = new MeshtasticRewriteParser();
  const bare = only(parser.parseLine('@AH7 FLEET_WHAT:AH7: STATUS'), 'alert') as SerialAlertEvent;
  assert.equal(bare.category, 'mesh-coordination');
  assert.equal(bare.nodeId, undefined);
  assert.deepEqual(bare.data, {
    coordinationType: 'FLEET_WHAT',
    sender: undefined,
    target: 'AH7',
    replyPrefix: 'AH7: STATUS',
  });
  const signed = parser.parseLine('AH1: @AH7 FLEET_WHAT:AH7: SCHED');
  const alert = only(signed, 'alert') as SerialAlertEvent;
  assert.equal(alert.nodeId, 'AH1');
  assert.equal((alert.data as Record<string, unknown>).sender, 'AH1');
  assert.equal((alert.data as Record<string, unknown>).replyPrefix, 'AH7: SCHED');
  assert.deepEqual(
    signed.map((r) => r.kind),
    ['alert'],
  );
});

test('SCHED_ITEM becomes a structured schedule alert credited to the node', () => {
  const parser = new MeshtasticRewriteParser();
  const results = parser.parseLine('AH7: SCHED_ITEM:1:2026-11-20T10:00|3600|/scan|SCAN_START:2:60');
  const alert = only(results, 'alert') as SerialAlertEvent;
  assert.equal(alert.category, 'schedule');
  assert.equal(alert.nodeId, 'AH7');
  assert.deepEqual(alert.data, {
    index: 1,
    nextStart: '2026-11-20T10:00',
    periodSeconds: 3600,
    path: '/scan',
    body: 'SCAN_START:2:60',
  });
  assert.deepEqual(credited(results), ['AH7']);
});

test('SCHED_ITEM body keeps pipes and an empty body', () => {
  const parser = new MeshtasticRewriteParser();
  const piped = only(
    parser.parseLine('AH7: SCHED_ITEM:2:2026-12-01T00:30|0|/cmd|CONFIG_TARGETS:a|b'),
    'alert',
  ) as SerialAlertEvent;
  assert.equal((piped.data as Record<string, unknown>).body, 'CONFIG_TARGETS:a|b');
  assert.equal((piped.data as Record<string, unknown>).periodSeconds, 0);
  const empty = only(
    parser.parseLine('AH7: SCHED_ITEM:3:2026-12-01T00:30|60|/cmd|'),
    'alert',
  ) as SerialAlertEvent;
  assert.equal((empty.data as Record<string, unknown>).body, '');
});

test('a schedule listing parses item by item and ends with SCHED_LIST', () => {
  const parser = new MeshtasticRewriteParser();
  const lines = [
    'AH7: SCHED_ITEM:1:2026-11-20T10:00|3600|/scan|SCAN_START:2:60',
    'AH7: SCHED_ITEM:2:2026-11-21T08:15|86400|/status|STATUS',
    'AH7: SCHED_LIST:2',
  ];
  const kinds = lines.map((line) => parser.parseLine(line).map((r) => r.kind));
  assert.deepEqual(kinds, [['alert'], ['alert'], ['command-result']]);
  const list = only(parser.parseLine(lines[2]), 'command-result');
  assert.equal(list.command, 'SCHED_LIST');
  assert.equal(list.payload, '2');
  assert.equal(list.nodeId, 'AH7');
  assert.equal(only(parser.parseLine('AH7: SCHED_ACK:OK'), 'command-ack').ackType, 'SCHED_ACK');
});

test('commands carrying the sender id are not parsed as status or acks from the sender', () => {
  const parser = new MeshtasticRewriteParser();
  for (const line of [
    'AH1: @AH7 STATUS',
    'AH1: @ALL STATUS',
    'AH1: @AH7 SCAN_START:2:60',
    'AH1: @AH7 STOP',
    'AH1: @AH7 SCHED_LIST',
    'AH1: @ALL CAMPAIGN_STATUS',
    'AH1: @AH7 CONFIG_TARGETS:AA:BB:CC:DD:EE:FF|11:22:33:44:55:66',
    'AH1: @ALL BASELINE_START:60',
    'AH1: @AH7 SCHED_ADD:2026-11-20T10:00|3600|/scan|SCAN_START:2:60',
  ]) {
    const results = parser.parseLine(line);
    assert.deepEqual(
      results.map((r) => r.kind),
      ['raw'],
      line,
    );
  }
});

test('echoed TRIANGULATE_START is ignored with or without the sender id', () => {
  const parser = new MeshtasticRewriteParser();
  assert.deepEqual(parser.parseLine('@ALL TRIANGULATE_START:AA:BB:CC:DD:EE:FF:300:AH1:2'), []);
  assert.deepEqual(parser.parseLine('AH1: @ALL TRIANGULATE_START:AA:BB:CC:DD:EE:FF:300:AH1:2'), []);
});

test('CHAN_ASSIGN from old nodes still parses', () => {
  const parser = new MeshtasticRewriteParser();
  const alert = only(parser.parseLine('AH5: CHAN_ASSIGN:AH6:1,6,11'), 'alert') as SerialAlertEvent;
  assert.equal(alert.category, 'mesh-coordination');
  assert.equal(alert.nodeId, 'AH5');
  assert.equal((alert.data as Record<string, unknown>).coordinationType, 'CHAN_ASSIGN');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
