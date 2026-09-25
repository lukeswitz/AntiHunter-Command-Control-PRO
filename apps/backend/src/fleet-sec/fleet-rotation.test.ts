import assert from 'node:assert/strict';

import {
  computeDrift,
  nextRetryPhase,
  pickRecoverySlot,
  pickStagingSlot,
  remainingTargets,
  retireGate,
} from './fleet-rotation';
import { NodeTrustRow } from './fleet-store';

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

function trust(partial: Partial<NodeTrustRow>): NodeTrustRow {
  return {
    nodeNum: 1,
    adminKeyFps: [],
    isManaged: false,
    lastVerifiedAt: null,
    lastVerifyMethod: null,
    lastDriftCheckAt: null,
    driftStatus: 'unknown',
    currentPskFp: null,
    previousPskFp: null,
    strandedSince: null,
    recoveryAttempts: 0,
    lastRecoveryAt: null,
    lastRecoveryError: null,
    notes: null,
    ...partial,
  };
}

console.log('staging slot');
test('picks the lowest free non-primary slot', () => {
  assert.equal(pickStagingSlot([1, 3, 5], 0), 1);
  assert.equal(pickStagingSlot([2, 4], 1), 2);
});
test('never picks the primary or slot 0', () => {
  assert.equal(pickStagingSlot([0, 1, 2], 0), 1);
  assert.equal(pickStagingSlot([0, 2, 3], 2), 3);
});
test('throws when no slot is free', () => {
  assert.throws(() => pickStagingSlot([0], 0));
});

console.log('recovery slot');
test('picks 2..7 avoiding used slots', () => {
  assert.equal(pickRecoverySlot([]), 2);
  assert.equal(pickRecoverySlot([2, 3]), 4);
  assert.throws(() => pickRecoverySlot([2, 3, 4, 5, 6, 7]));
});

console.log('retry phase');
test('failed_b resumes at pending, failed_c at has_new_psk', () => {
  assert.equal(nextRetryPhase('failed_b'), 'pending');
  assert.equal(nextRetryPhase('phase_b_pushing'), 'pending');
  assert.equal(nextRetryPhase('failed_c'), 'has_new_psk');
  assert.equal(nextRetryPhase('phase_c_promoting'), 'has_new_psk');
  assert.equal(nextRetryPhase('on_new_psk'), null);
  assert.equal(nextRetryPhase('retired'), null);
});

console.log('retire gate');
test('gate opens only when every managed node is on the new PSK', () => {
  const managed = [
    trust({ nodeNum: 1, isManaged: true, currentPskFp: 'new' }),
    trust({ nodeNum: 2, isManaged: true, currentPskFp: 'old' }),
    trust({ nodeNum: 3, isManaged: true, currentPskFp: 'new' }),
  ];
  const blocked = retireGate(managed, 'new');
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.laggards, [2]);
  const open = retireGate(
    managed.map((m) => ({ ...m, currentPskFp: 'new' })),
    'new',
  );
  assert.equal(open.ok, true);
  assert.deepEqual(open.laggards, []);
});

console.log('drift');
test('unreachable wins, then unknown, then policy compare', () => {
  assert.equal(computeDrift(trust({ driftStatus: 'unreachable' }), null), 'unreachable');
  assert.equal(
    computeDrift(trust({ lastVerifiedAt: null }), {
      expectedIsManaged: false,
      expectedAdminKeyFps: [],
    }),
    'unknown',
  );
  assert.equal(
    computeDrift(trust({ lastVerifiedAt: new Date(), isManaged: true, adminKeyFps: ['a'] }), {
      expectedIsManaged: true,
      expectedAdminKeyFps: ['a'],
    }),
    'in-policy',
  );
  assert.equal(
    computeDrift(trust({ lastVerifiedAt: new Date(), isManaged: false }), {
      expectedIsManaged: true,
      expectedAdminKeyFps: [],
    }),
    'drift',
  );
  assert.equal(
    computeDrift(trust({ lastVerifiedAt: new Date(), isManaged: true, adminKeyFps: ['a'] }), {
      expectedIsManaged: true,
      expectedAdminKeyFps: ['a', 'b'],
    }),
    'drift',
  );
});

console.log('remaining targets');
test('drops done/retired targets', () => {
  const left = remainingTargets([
    { nodeNum: 1, phase: 'on_new_psk', attempts: 0 },
    { nodeNum: 2, phase: 'pending', attempts: 0 },
    { nodeNum: 3, phase: 'retired', attempts: 0 },
    { nodeNum: 4, phase: 'failed_b', attempts: 1 },
  ]);
  assert.deepEqual(
    left.map((t) => t.nodeNum),
    [2, 4],
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
