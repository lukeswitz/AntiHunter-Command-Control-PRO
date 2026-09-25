import { create, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { Subject } from 'rxjs';

import { StatusBroadcastService } from './status-broadcast.service';
import { buildStatusFrame, formatUptime, isStatusRequestFor } from './status-frame';
import { AppConfigService } from '../app-config/app-config.service';
import { MeshtasticRewriteParser } from '../serial/protocols/meshtastic-rewrite.parser';
import { LocalRadioInfo, QueueCommandRequest, SerialService } from '../serial/serial.service';

const FIRMWARE_STATUS =
  /^[^:]+: STATUS: Mode:\S+ Scan:(ACTIVE|IDLE) Hits:\d+ Temp:(-?\d+\.\d|\?)C Up:\d{2}:\d{2}:\d{2}( GPS:-?\d+\.\d{6},-?\d+\.\d{6})?/;

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  console.log('frame');
  await test('uptime formats as HH:MM:SS', () => {
    assert.equal(formatUptime(0), '00:00:00');
    assert.equal(formatUptime(3725), '01:02:05');
    assert.equal(formatUptime(90061), '25:01:01');
  });
  await test('frame matches firmware STATUS shape', () => {
    const frame = buildStatusFrame({
      name: 'CMD1',
      hits: 7,
      tempC: 41.26,
      uptimeSec: 3725,
      lat: 12.5,
      lon: -65.25,
      batteryLevel: 87,
    });
    assert.match(
      frame,
      /^CMD1: STATUS: Mode:C2 Scan:IDLE Hits:7 Temp:41\.3C Up:01:02:05 GPS:12\.50{5},-65\.250{4} Batt:87%$/,
    );
    assert.match(frame, FIRMWARE_STATUS);
  });
  await test('unknown temperature and no GPS', () => {
    const frame = buildStatusFrame({ name: 'CMD1', hits: 0, uptimeSec: 5 });
    assert.equal(frame, 'CMD1: STATUS: Mode:C2 Scan:IDLE Hits:0 Temp:?C Up:00:00:05');
    assert.match(frame, FIRMWARE_STATUS);
  });

  console.log('parser round trip');
  const parser = new MeshtasticRewriteParser();
  await test('AHCC parses its own frame with GPS', () => {
    const events = parser.parseLine(
      buildStatusFrame({ name: 'CMD1', hits: 3, tempC: 40, uptimeSec: 60, lat: 1.5, lon: 2.5 }),
    );
    const telemetry = events.find((event) => event.kind === 'node-telemetry');
    assert.ok(telemetry, JSON.stringify(events));
    assert.equal((telemetry as { nodeId: string }).nodeId, 'CMD1');
    assert.equal((telemetry as { lat?: number }).lat, 1.5);
    assert.equal((telemetry as { temperatureC?: number }).temperatureC, 40);
  });
  await test('AHCC parses frame with unknown temperature', () => {
    const events = parser.parseLine(
      'DIGI: STATUS: Mode:C2 Scan:IDLE Hits:4 Temp:?C Up:00:10:00 Batt:90%',
    );
    const telemetry = events.find((event) => event.kind === 'node-telemetry');
    assert.ok(telemetry, JSON.stringify(events));
    assert.equal((telemetry as { temperatureC?: number }).temperatureC, undefined);
  });
  await test('firmware STATUS still parses', () => {
    const events = parser.parseLine(
      'AH12: STATUS: Mode:WiFi+BLE Scan:ACTIVE Hits:12 Temp:38.5C Up:02:00:00 GPS:10.5,20.25 HDOP=1.2',
    );
    const telemetry = events.find((event) => event.kind === 'node-telemetry') as
      | { lat?: number; temperatureC?: number }
      | undefined;
    assert.equal(telemetry?.lat, 10.5);
    assert.equal(telemetry?.temperatureC, 38.5);
  });

  console.log('status request');
  await test('matches @ALL and own short name only', () => {
    assert.ok(isStatusRequestFor('@ALL STATUS', 'CMD1'));
    assert.ok(isStatusRequestFor('  @cmd1 status ', 'CMD1'));
    assert.ok(!isStatusRequestFor('@AH12 STATUS', 'CMD1'));
    assert.ok(!isStatusRequestFor('@ALL STATUS:extra', 'CMD1'));
    assert.ok(!isStatusRequestFor('CMD1: STATUS: Mode:C2', 'CMD1'));
    assert.ok(!isStatusRequestFor('@CMD1 STATUS', undefined));
  });

  console.log('local radio from protobuf');
  await test('myInfo + nodeInfo identify the local radio', async () => {
    const { Mesh } = (await import('@meshtastic/protobufs')) as unknown as {
      Mesh: Record<string, Parameters<typeof create>[0]>;
    };
    const service = new SerialService(
      { get: (_key: string, fallback?: unknown) => fallback } as never,
      {} as never,
    );
    const feed = (value: unknown) =>
      (
        service as unknown as { handleMeshtasticFrame(frame: Buffer): Promise<void> }
      ).handleMeshtasticFrame(
        Buffer.from(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, value as never))),
      );
    await feed({ payloadVariant: { case: 'myInfo', value: { myNodeNum: 0x1234abcd } } });
    await feed({
      payloadVariant: {
        case: 'nodeInfo',
        value: {
          num: 0x0badf00d,
          user: { longName: 'Other', shortName: 'OTH' },
          position: { latitudeI: 50_000_000, longitudeI: 60_000_000 },
        },
      },
    });
    await feed({
      payloadVariant: {
        case: 'nodeInfo',
        value: {
          num: 0x1234abcd,
          user: { longName: 'Command Post', shortName: 'CMD1' },
          position: { latitudeI: 125_000_000, longitudeI: -652_500_000 },
          deviceMetrics: { batteryLevel: 87 },
        },
      },
    });
    const radio = service.getLocalRadio();
    assert.equal(radio.num, 0x1234abcd);
    assert.equal(radio.shortName, 'CMD1');
    assert.equal(radio.lat, 12.5);
    assert.equal(radio.lon, -65.25);
    assert.equal(radio.batteryLevel, 87);
    assert.equal(service.getMeshNodeCount(), 2);
  });

  console.log('broadcaster');
  const sent: QueueCommandRequest[] = [];
  const incoming = new Subject<string>();
  let radio: LocalRadioInfo = {
    num: 1,
    shortName: 'CMD1',
    lat: 12.5,
    lon: -65.5,
    positionAt: Date.now(),
    batteryLevel: 55,
  };
  const settings = {
    statusBroadcastEnabled: true,
    statusBroadcastIntervalSec: 600,
    statusBroadcastGps: false,
    statusReplyEnabled: false,
  };
  const fakeSerial = {
    ownsPort: () => true,
    getIncomingStream: () => incoming.asObservable(),
    getRadioInfo: async () => ({ radio, meshNodeCount: 4 }),
    queueCommand: async (request: QueueCommandRequest) => {
      sent.push(request);
    },
  } as unknown as SerialService;
  const fakeConfig = { getSettings: async () => settings } as unknown as AppConfigService;
  const broadcaster = new StatusBroadcastService(fakeSerial, fakeConfig);
  broadcaster.onModuleInit();

  try {
    await test('sends frame as @ALL broadcast without GPS by default', async () => {
      const result = await broadcaster.trigger();
      assert.equal(result.sent, true);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].target, '@ALL');
      assert.match(sent[0].line ?? '', /^CMD1: STATUS: Mode:C2 Scan:IDLE Hits:4 Temp:/);
      assert.ok(!(sent[0].line ?? '').includes('GPS:'));
      assert.ok((sent[0].line ?? '').endsWith('Batt:55%'));
    });
    await test('includes GPS only when enabled and fresh', async () => {
      settings.statusBroadcastGps = true;
      await broadcaster.trigger();
      assert.match(sent[1].line ?? '', / GPS:12\.50{5},-65\.50{5} /);
      radio = { ...radio, positionAt: Date.now() - 11 * 60_000 };
      await broadcaster.trigger();
      assert.ok(!(sent[2].line ?? '').includes('GPS:'));
      settings.statusBroadcastGps = false;
    });
    await test('does not answer STATUS requests unless enabled', async () => {
      const before = sent.length;
      incoming.next('@ALL STATUS');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sent.length, before);
      settings.statusReplyEnabled = true;
      incoming.next('@CMD1 STATUS');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sent.length, before + 1);
      incoming.next('@AH12 STATUS');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(sent.length, before + 1);
    });
    await test('skips when the radio is not identified', async () => {
      radio = {};
      const before = sent.length;
      const result = await broadcaster.trigger();
      assert.equal(result.sent, false);
      assert.equal(sent.length, before);
    });
  } finally {
    broadcaster.onModuleDestroy();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
