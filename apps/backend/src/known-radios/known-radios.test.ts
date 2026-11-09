import assert from 'node:assert/strict';

import { KnownRadiosService } from './known-radios.service';
import type { CommandsService } from '../commands/commands.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SerialAlertEvent } from '../serial/serial.types';

type Row = {
  mac: string;
  radio: string;
  name: string | null;
  addedBy: string | null;
  createdAt: Date;
};

const rows = new Map<string, Row>();
const sent: string[] = [];

const prisma = {
  knownMeshRadio: {
    findMany: async () => [...rows.values()],
    upsert: async ({ create }: { create: Row }) => {
      const row = { ...create, createdAt: new Date() };
      rows.set(row.mac, row);
      return row;
    },
    delete: async ({ where }: { where: { mac: string } }) => {
      rows.delete(where.mac);
    },
  },
} as unknown as PrismaService;

const commands = {
  sendCommand: async (dto: { target: string; name: string; params: string[] }) => {
    sent.push(`${dto.target} ${dto.name}:${dto.params.join(':')}`);
  },
} as unknown as CommandsService;

function sighting(mac: string, name?: string): SerialAlertEvent {
  return {
    kind: 'alert',
    level: 'ALERT',
    category: 'sentinel',
    nodeId: 'AH5',
    message: `RADIO_DETECTED:Meshtastic:${mac}:-40`,
    data: { detectionType: 'RADIO_DETECTED', radio: 'Meshtastic', mac, rssi: -40, name },
    raw: '',
  };
}

let failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const service = new KnownRadiosService(prisma, commands);
  await service.onModuleInit();

  await check('unknown radio is not suppressed and shows as recent', async () => {
    assert.equal(service.observe(sighting('AA:BB:CC:DD:EE:01', 'Base_e190')), false);
    const { recent } = service.list();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].name, 'Base_e190');
    assert.equal(recent[0].known, false);
  });

  await check('mark known stores the radio and sends RADIO_KNOWN_ADD to all nodes', async () => {
    await service.add({ mac: 'aa:bb:cc:dd:ee:01', radio: 'meshtastic', name: 'Base_e190' });
    assert.deepEqual(sent, ['@ALL RADIO_KNOWN_ADD:AA:BB:CC:DD:EE:01:Meshtastic:Base_e190']);
    assert.equal(service.observe(sighting('AA:BB:CC:DD:EE:01')), true);
    assert.equal(service.list().recent[0].known, true);
    assert.equal(service.list().recent[0].name, 'Base_e190');
  });

  await check('other alerts pass through', async () => {
    const other: SerialAlertEvent = {
      ...sighting('AA:BB:CC:DD:EE:01'),
      data: { detectionType: 'PWNAGOTCHI' },
    };
    assert.equal(service.observe(other), false);
  });

  await check('sync resends every known radio', async () => {
    sent.length = 0;
    assert.deepEqual(await service.sync(), { sent: 1 });
    assert.deepEqual(sent, ['@ALL RADIO_KNOWN_ADD:AA:BB:CC:DD:EE:01:Meshtastic:Base_e190']);
  });

  await check('remove deletes it and sends RADIO_KNOWN_DEL', async () => {
    sent.length = 0;
    await service.remove('AA:BB:CC:DD:EE:01');
    assert.deepEqual(sent, ['@ALL RADIO_KNOWN_DEL:AA:BB:CC:DD:EE:01']);
    assert.equal(service.observe(sighting('AA:BB:CC:DD:EE:01')), false);
    await assert.rejects(service.remove('AA:BB:CC:DD:EE:01'));
  });

  await check('a bad radio type is rejected before anything is stored or sent', async () => {
    sent.length = 0;
    await assert.rejects(service.add({ mac: 'AA:BB:CC:DD:EE:02', radio: 'LoRaWAN' }));
    assert.equal(rows.has('AA:BB:CC:DD:EE:02'), false);
    assert.deepEqual(sent, []);
  });

  console.log(`\n  ${6 - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
