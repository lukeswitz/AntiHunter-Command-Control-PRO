import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';

import { RadioAction, SerialService } from './serial.service';

type Proto = typeof import('@meshtastic/protobufs', {
  with: { 'resolution-mode': 'import' },
});

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

const LOCAL = 0x1234abcd;
const BROADCAST = 0xffffffff;

async function main() {
  const proto = (await import('@meshtastic/protobufs')) as unknown as Proto;
  const { Admin, Config, Mesh, Portnums } = proto;

  const written: Buffer[] = [];
  const lineChanges: Array<{ dtr: boolean; rts: boolean }> = [];
  const fakePort = {
    isOpen: true,
    write: (buffer: Buffer, cb: (error?: Error | null) => void) => {
      written.push(Buffer.from(buffer));
      cb(null);
    },
    drain: (cb: (error?: Error | null) => void) => cb(null),
    set: (lines: { dtr: boolean; rts: boolean }, cb: (error?: Error | null) => void) => {
      lineChanges.push(lines);
      cb(null);
    },
  };

  const service = new SerialService(
    { get: (_key: string, fallback?: unknown) => fallback } as never,
    {} as never,
  );
  const internals = service as unknown as {
    port?: unknown;
    handleMeshtasticFrame(frame: Buffer): Promise<void>;
  };
  const feed = (value: unknown) =>
    internals.handleMeshtasticFrame(
      Buffer.from(toBinary(Mesh.FromRadioSchema, create(Mesh.FromRadioSchema, value as never))),
    );
  const lastPacket = () => {
    const frame = written[written.length - 1];
    assert.equal(frame[0], 0x94);
    assert.equal(frame[1], 0xc3);
    assert.equal((frame[2] << 8) | frame[3], frame.length - 4);
    const toRadio = fromBinary(Mesh.ToRadioSchema, frame.subarray(4));
    assert.equal(toRadio.payloadVariant.case, 'packet');
    const packet = toRadio.payloadVariant.value as {
      to: number;
      wantAck: boolean;
      payloadVariant: {
        case: string;
        value: { portnum: number; payload: Uint8Array; wantResponse: boolean };
      };
    };
    assert.equal(packet.payloadVariant.case, 'decoded');
    return { to: packet.to, wantAck: packet.wantAck, data: packet.payloadVariant.value };
  };
  const lastAdmin = () => {
    const { to, data } = lastPacket();
    assert.equal(to, LOCAL);
    assert.equal(data.portnum, Portnums.PortNum.ADMIN_APP);
    return fromBinary(Admin.AdminMessageSchema, data.payload).payloadVariant;
  };
  const act = (request: RadioAction) => service.radioAction(request);

  console.log('guards');
  await test('actions fail cleanly when not connected', async () => {
    await assert.rejects(() => act({ action: 'wake' }), /not connected/);
  });
  internals.port = fakePort;
  await test('admin actions need the radio identified', async () => {
    await assert.rejects(() => act({ action: 'reboot', seconds: 5 }), /Radio not identified/);
    assert.equal(written.length, 0);
  });

  await feed({ payloadVariant: { case: 'myInfo', value: { myNodeNum: LOCAL } } });
  await feed({
    payloadVariant: {
      case: 'nodeInfo',
      value: { num: LOCAL, user: { longName: 'Command Post', shortName: 'CMD1' } },
    },
  });
  await feed({
    payloadVariant: { case: 'nodeInfo', value: { num: 0x0badf00d, user: { longName: 'Other' } } },
  });

  await test('config changes need the radio config loaded', async () => {
    await assert.rejects(() => act({ action: 'setGpsMode', gpsMode: 2 }), /settings not loaded/);
  });

  await feed({
    payloadVariant: {
      case: 'config',
      value: {
        payloadVariant: {
          case: 'position',
          value: {
            positionBroadcastSecs: 900,
            fixedPosition: true,
            gpsMode: Config.Config_PositionConfig_GpsMode.ENABLED,
            broadcastSmartMinimumDistance: 100,
          },
        },
      },
    },
  });
  await feed({
    payloadVariant: {
      case: 'config',
      value: {
        payloadVariant: {
          case: 'display',
          value: { screenOnSecs: 60, flipScreen: true, units: 1, headingBold: true },
        },
      },
    },
  });
  await feed({
    payloadVariant: {
      case: 'config',
      value: {
        payloadVariant: { case: 'bluetooth', value: { enabled: true, mode: 1, fixedPin: 123456 } },
      },
    },
  });
  await feed({
    payloadVariant: {
      case: 'config',
      value: {
        payloadVariant: {
          case: 'lora',
          value: { region: 1, modemPreset: 0, hopLimit: 3, txEnabled: true },
        },
      },
    },
  });

  console.log('radio info');
  await test('info reflects radio identity and config', async () => {
    const info = await service.getRadioInfo();
    assert.equal(info.ownsPort, true);
    assert.equal(info.connected, true);
    assert.equal(info.radio.num, LOCAL);
    assert.equal(info.radio.shortName, 'CMD1');
    assert.equal(info.meshNodeCount, 2);
    assert.deepEqual(info.config.position, {
      gpsMode: 1,
      fixedPosition: true,
      positionBroadcastSecs: 900,
    });
    assert.deepEqual(info.config.display, { screenOnSecs: 60 });
    assert.deepEqual(info.config.bluetooth, { enabled: true, mode: 1 });
    assert.equal(JSON.stringify(info).includes('123456'), false);
    assert.deepEqual(info.config.lora, { region: 1, modemPreset: 0, hopLimit: 3, txEnabled: true });
  });

  console.log('admin messages');
  await test('reboot', async () => {
    await act({ action: 'reboot', seconds: 5 });
    assert.deepEqual(lastAdmin(), { case: 'rebootSeconds', value: 5 });
    assert.equal(lastPacket().wantAck, true);
  });
  await test('shutdown', async () => {
    await act({ action: 'shutdown', seconds: 10 });
    assert.deepEqual(lastAdmin(), { case: 'shutdownSeconds', value: 10 });
  });
  await test('sync radio clock to host time', async () => {
    const before = Math.floor(Date.now() / 1000);
    await act({ action: 'syncTime' });
    const variant = lastAdmin();
    assert.equal(variant.case, 'setTimeOnly');
    assert.ok(Math.abs((variant.value as number) - before) <= 1);
  });
  await test('fixed position in 1e-7 degrees', async () => {
    await act({ action: 'setFixedPosition', lat: 12.5, lon: -65.25, alt: 30 });
    const variant = lastAdmin();
    assert.equal(variant.case, 'setFixedPosition');
    const position = variant.value as { latitudeI: number; longitudeI: number; altitude: number };
    assert.equal(position.latitudeI, 125_000_000);
    assert.equal(position.longitudeI, -652_500_000);
    assert.equal(position.altitude, 30);
  });
  await test('remove fixed position', async () => {
    await act({ action: 'removeFixedPosition' });
    assert.deepEqual(lastAdmin(), { case: 'removeFixedPosition', value: true });
  });

  console.log('config changes keep the rest of the section');
  const lastConfig = (section: string) => {
    const variant = lastAdmin();
    assert.equal(variant.case, 'setConfig');
    const config = (
      variant.value as { payloadVariant: { case: string; value: Record<string, unknown> } }
    ).payloadVariant;
    assert.equal(config.case, section);
    return config.value;
  };
  await test('GPS mode change keeps broadcast interval and fixed position', async () => {
    await act({ action: 'setGpsMode', gpsMode: Config.Config_PositionConfig_GpsMode.NOT_PRESENT });
    const position = lastConfig('position');
    assert.equal(position.gpsMode, 2);
    assert.equal(position.positionBroadcastSecs, 900);
    assert.equal(position.fixedPosition, true);
    assert.equal(position.broadcastSmartMinimumDistance, 100);
  });
  await test('screen timeout change keeps flip, units, bold', async () => {
    await act({ action: 'setDisplay', screenOnSecs: 300 });
    const display = lastConfig('display');
    assert.equal(display.screenOnSecs, 300);
    assert.equal(display.flipScreen, true);
    assert.equal(display.units, 1);
    assert.equal(display.headingBold, true);
  });
  await test('bluetooth toggle keeps PIN when not given', async () => {
    await act({ action: 'setBluetooth', enabled: false });
    const bluetooth = lastConfig('bluetooth');
    assert.equal(bluetooth.enabled, false);
    assert.equal(bluetooth.mode, 1);
    assert.equal(bluetooth.fixedPin, 123456);
  });
  await test('cached config follows the change', async () => {
    const info = await service.getRadioInfo();
    assert.equal(info.config.position?.gpsMode, 2);
    assert.equal(info.config.display?.screenOnSecs, 300);
    assert.equal(info.config.bluetooth?.enabled, false);
  });

  console.log('node database and requests');
  await test('node database reset keeps only our own node', async () => {
    await act({ action: 'nodedbReset' });
    assert.deepEqual(lastAdmin(), { case: 'nodedbReset', value: 1 });
    assert.equal((await service.getRadioInfo()).meshNodeCount, 1);
  });
  await test('node info request broadcasts with want_response', async () => {
    await act({ action: 'requestNodeInfo' });
    const { to, wantAck, data } = lastPacket();
    assert.equal(to, BROADCAST);
    assert.equal(wantAck, false);
    assert.equal(data.portnum, Portnums.PortNum.NODEINFO_APP);
    assert.equal(data.wantResponse, true);
  });
  await test('telemetry request to a peer', async () => {
    await act({ action: 'requestTelemetry', nodeNum: 0x0badf00d });
    const { to, data } = lastPacket();
    assert.equal(to, 0x0badf00d);
    assert.equal(data.portnum, Portnums.PortNum.TELEMETRY_APP);
    assert.equal(data.wantResponse, true);
  });
  await test('telemetry request defaults to our radio', async () => {
    await act({ action: 'requestTelemetry' });
    assert.equal(lastPacket().to, LOCAL);
  });

  console.log('hardware');
  await test('wake pulses RTS high then low with DTR low', async () => {
    await act({ action: 'wake' });
    assert.deepEqual(lineChanges, [
      { dtr: false, rts: true },
      { dtr: false, rts: false },
    ]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
