import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';

import { RadioReKeyRefused } from './fleet-admin.types';
import { SerialService } from './serial.service';

type Proto = typeof import('@meshtastic/protobufs', {
  with: { 'resolution-mode': 'import' },
});

const LOCAL = 0x11223344;
const REMOTE = 0x0badf00d;

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

function decodeFrame(proto: Proto, frame: Buffer) {
  assert.equal(frame[0], 0x94);
  assert.equal(frame[1], 0xc3);
  const len = (frame[2] << 8) | frame[3];
  assert.equal(len, frame.length - 4);
  const toRadio = fromBinary(proto.Mesh.ToRadioSchema, frame.subarray(4));
  assert.equal(toRadio.payloadVariant.case, 'packet');
  const packet = toRadio.payloadVariant.value as {
    id: number;
    to: number;
    pkiEncrypted: boolean;
    wantAck: boolean;
    payloadVariant: {
      case: string;
      value: { portnum: number; payload: Uint8Array; wantResponse: boolean; requestId?: number };
    };
  };
  const admin = fromBinary(proto.Admin.AdminMessageSchema, packet.payloadVariant.value.payload);
  return { packet, data: packet.payloadVariant.value, admin };
}

async function main() {
  const proto = (await import('@meshtastic/protobufs')) as unknown as Proto;
  const { Admin, Channel, Config, Mesh, Portnums } = proto;

  const written: Buffer[] = [];
  const fakePort = {
    isOpen: true,
    write: (buffer: Buffer, cb: (e?: Error | null) => void) => {
      written.push(Buffer.from(buffer));
      cb(null);
    },
    drain: (cb: (e?: Error | null) => void) => cb(null),
  };
  const service = new SerialService(
    { get: (_k: string, fallback?: unknown) => fallback } as never,
    {} as never,
  );
  const internals = service as unknown as {
    port?: unknown;
    handleMeshtasticFrame(frame: Buffer): Promise<void>;
  };
  internals.port = fakePort;
  await internals.handleMeshtasticFrame(
    Buffer.from(
      toBinary(
        Mesh.FromRadioSchema,
        create(Mesh.FromRadioSchema, {
          payloadVariant: { case: 'myInfo', value: { myNodeNum: LOCAL } },
        }),
      ),
    ),
  );

  // Feed a FromRadio packet carrying an ADMIN_APP reply, correlating on requestId.
  const feedAdminReply = async (
    from: number,
    requestId: number,
    adminInit: Record<string, unknown>,
  ) => {
    const admin = create(Admin.AdminMessageSchema, adminInit as never);
    const packet = create(Mesh.MeshPacketSchema, {
      from,
      to: LOCAL,
      payloadVariant: {
        case: 'decoded',
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.ADMIN_APP,
          payload: toBinary(Admin.AdminMessageSchema, admin),
          requestId,
        }),
      },
    });
    await internals.handleMeshtasticFrame(
      Buffer.from(
        toBinary(
          Mesh.FromRadioSchema,
          create(Mesh.FromRadioSchema, { payloadVariant: { case: 'packet', value: packet } }),
        ),
      ),
    );
  };

  const feedRoutingAck = async (from: number, requestId: number, errorReason: number) => {
    const routing = create(Mesh.RoutingSchema, {
      variant: { case: 'errorReason', value: errorReason },
    });
    const packet = create(Mesh.MeshPacketSchema, {
      from,
      to: LOCAL,
      payloadVariant: {
        case: 'decoded',
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.ROUTING_APP,
          payload: toBinary(Mesh.RoutingSchema, routing),
          requestId,
        }),
      },
    });
    await internals.handleMeshtasticFrame(
      Buffer.from(
        toBinary(
          Mesh.FromRadioSchema,
          create(Mesh.FromRadioSchema, { payloadVariant: { case: 'packet', value: packet } }),
        ),
      ),
    );
  };

  const lastReqId = () => decodeFrame(proto, written[written.length - 1]).packet.id;

  console.log('local get security');
  await test('builds a local ADMIN_APP get_config(security) request and decodes the reply', async () => {
    const p = service.fleetGetSecurity(LOCAL);
    await new Promise((r) => setTimeout(r, 20));
    const sent = decodeFrame(proto, written[written.length - 1]);
    assert.equal(sent.packet.to, LOCAL);
    assert.equal(sent.packet.pkiEncrypted, false);
    assert.equal(sent.data.portnum, Portnums.PortNum.ADMIN_APP);
    assert.equal(sent.data.wantResponse, true);
    assert.equal(sent.admin.payloadVariant.case, 'getConfigRequest');
    assert.equal(sent.admin.payloadVariant.value, 7);
    const adminKey = Buffer.alloc(32, 9);
    const pub = Buffer.alloc(32, 7);
    await feedAdminReply(LOCAL, sent.packet.id, {
      payloadVariant: {
        case: 'getConfigResponse',
        value: create(Config.ConfigSchema, {
          payloadVariant: {
            case: 'security',
            value: { publicKey: pub, adminKey: [adminKey], isManaged: true },
          },
        }),
      },
    });
    const view = await p;
    assert.ok(view.publicKey.equals(pub));
    assert.equal(view.adminKeys.length, 1);
    assert.ok(view.adminKeys[0].equals(adminKey));
    assert.equal(view.isManaged, true);
    assert.equal(view.hasPrivateKey, false);
  });

  console.log('remote get channel + session passkey');
  await test('remote get_channel is PKC, sends index+1, caches the reply passkey', async () => {
    const p = service.fleetGetChannel(REMOTE, 0);
    await new Promise((r) => setTimeout(r, 20));
    const sent = decodeFrame(proto, written[written.length - 1]);
    assert.equal(sent.packet.to, REMOTE);
    assert.equal(sent.packet.pkiEncrypted, true);
    assert.equal(sent.admin.payloadVariant.case, 'getChannelRequest');
    assert.equal(sent.admin.payloadVariant.value, 1);
    const psk = Buffer.alloc(16, 3);
    await feedAdminReply(REMOTE, sent.packet.id, {
      sessionPasskey: Buffer.from([1, 2, 3, 4]),
      payloadVariant: {
        case: 'getChannelResponse',
        value: create(Channel.ChannelSchema, {
          index: 0,
          role: 1,
          settings: { name: 'primary', psk },
        }),
      },
    });
    const ch = await p;
    assert.equal(ch.role, 'PRIMARY');
    assert.equal(ch.name, 'primary');
    assert.ok(ch.psk.equals(psk));
  });
  await test('a later remote set-channel carries the cached session passkey', async () => {
    const p = service
      .fleetSetChannelLocal({ index: 1, name: '', role: 'SECONDARY', psk: Buffer.alloc(16, 5) })
      .catch(() => undefined);
    // local set-channel is not PKC; use a remote fire-forget to check passkey injection instead
    await p;
    const fire = service.fleetFireForget(REMOTE, { t: 'beginEdit' });
    await new Promise((r) => setTimeout(r, 20));
    const sent = decodeFrame(proto, written[written.length - 1]);
    assert.deepEqual(Array.from(sent.admin.sessionPasskey ?? []), [1, 2, 3, 4]);
    await fire;
  });

  console.log('re-key guard (finding #17)');
  await test('OTA set-security without a private key is refused, not sent', async () => {
    const before = written.length;
    await assert.rejects(
      () => service.fleetSetSecurity(REMOTE, { adminKeys: [Buffer.alloc(32, 1)] }),
      RadioReKeyRefused,
    );
    assert.equal(written.length, before);
  });

  console.log('routing ack resolves set, error rejects');
  await test('local set-channel resolves on a NONE routing ack', async () => {
    const p = service.fleetSetChannelLocal({
      index: 2,
      name: '',
      role: 'SECONDARY',
      psk: Buffer.alloc(16, 8),
    });
    await new Promise((r) => setTimeout(r, 20));
    const id = lastReqId();
    const sent = decodeFrame(proto, written[written.length - 1]);
    assert.equal(sent.admin.payloadVariant.case, 'setChannel');
    assert.equal(sent.data.wantResponse, false);
    await feedRoutingAck(LOCAL, id, 0);
    await p;
  });
  await test('a routing error rejects the transaction', async () => {
    const p = service.fleetSetChannelLocal({
      index: 3,
      name: '',
      role: 'SECONDARY',
      psk: Buffer.alloc(16, 8),
    });
    await new Promise((r) => setTimeout(r, 20));
    const id = lastReqId();
    const rejected = assert.rejects(() => p, /routing error 5/);
    await feedRoutingAck(LOCAL, id, 5);
    await rejected;
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
