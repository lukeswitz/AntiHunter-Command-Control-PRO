import assert from 'node:assert/strict';

import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { PrismaService } from '../prisma/prisma.service';
import { AlertChannelsService } from '../push/alert-channels.service';
import { defaultTier } from '../push/alert-sources';
import { SerialAlertEvent } from '../serial/serial.types';

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

function harness(tiers: Record<string, 'off' | 'alert' | 'critical'> = {}) {
  const prisma = {
    webhook: { findMany: async () => [{ id: 'w1', enabled: true }] },
  } as unknown as PrismaService;
  const channels = {
    isSourceMuted: async (source: string) => (tiers[source] ?? defaultTier(source)) === 'off',
    alert: async () => undefined,
  } as unknown as AlertChannelsService;
  const dispatcher = new WebhookDispatcherService(prisma, channels);
  const delivered: string[] = [];
  (
    dispatcher as unknown as { deliver: (w: unknown, c: { event: string }) => Promise<void> }
  ).deliver = async (_w, c) => {
    delivered.push(c.event);
  };
  return { dispatcher, delivered };
}

function nodeEvent(category: string, level: SerialAlertEvent['level']): SerialAlertEvent {
  return { kind: 'alert', level, category, nodeId: 'AH61', message: `AH61: ${category}`, raw: 'x' };
}

async function main() {
  console.log('node alert webhook sources');
  await test('unmapped node events obey Alert sources (default off)', async () => {
    const { dispatcher, delivered } = harness();
    await dispatcher.dispatchNodeAlert(nodeEvent('sentinel', 'NOTICE'));
    await dispatcher.dispatchNodeAlert(nodeEvent('triangulation', 'INFO'));
    assert.equal(delivered.length, 0);
  });
  await test('unmapped node events sent when Node status is ticked', async () => {
    const { dispatcher, delivered } = harness({ 'node:status': 'alert' });
    await dispatcher.dispatchNodeAlert(nodeEvent('sentinel', 'NOTICE'));
    assert.equal(delivered.length, 1);
  });
  await test('mapped ALERT events still delivered by default', async () => {
    const { dispatcher, delivered } = harness();
    await dispatcher.dispatchNodeAlert(nodeEvent('tamper', 'ALERT'));
    assert.equal(delivered.length, 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
