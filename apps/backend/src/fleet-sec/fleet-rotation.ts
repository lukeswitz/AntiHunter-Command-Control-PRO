import { DriftStatus, NodeTrustRow, RotationPhase, RotationTarget } from './fleet-store';

export const MAX_CHANNEL_SLOTS = 8;

export function pickStagingSlot(emptySlots: number[], primary: number): number {
  const candidate = emptySlots
    .filter((s) => s !== primary && s > 0 && s < MAX_CHANNEL_SLOTS)
    .sort((a, b) => a - b)[0];
  if (candidate === undefined) {
    throw new Error('no free channel slot available to stage the new PSK');
  }
  return candidate;
}

export function pickRecoverySlot(used: number[]): number {
  for (let slot = 2; slot <= 7; slot += 1) {
    if (!used.includes(slot)) {
      return slot;
    }
  }
  throw new Error('no free recovery slot (2-7) available');
}

export function nextRetryPhase(phase: RotationPhase): RotationPhase | null {
  switch (phase) {
    case 'failed_b':
    case 'phase_b_pushing':
      return 'pending';
    case 'failed_c':
    case 'phase_c_promoting':
      return 'has_new_psk';
    case 'pending':
    case 'has_new_psk':
      return phase;
    case 'on_new_psk':
    case 'retired':
      return null;
    default:
      return 'pending';
  }
}

export function retireGate(
  managed: NodeTrustRow[],
  newPskFp: string,
): { ok: boolean; laggards: number[] } {
  const laggards = managed.filter((n) => n.currentPskFp !== newPskFp).map((n) => n.nodeNum);
  return { ok: laggards.length === 0, laggards };
}

export function computeDrift(
  n: Pick<NodeTrustRow, 'driftStatus' | 'lastVerifiedAt' | 'isManaged' | 'adminKeyFps'>,
  policy: { expectedIsManaged: boolean; expectedAdminKeyFps: string[] } | null,
): DriftStatus {
  if (n.driftStatus === 'unreachable') {
    return 'unreachable';
  }
  if (!n.lastVerifiedAt) {
    return 'unknown';
  }
  if (!policy) {
    return 'in-policy';
  }
  if (policy.expectedIsManaged !== n.isManaged) {
    return 'drift';
  }
  const got = new Set(n.adminKeyFps);
  for (const want of policy.expectedAdminKeyFps) {
    if (!got.has(want)) {
      return 'drift';
    }
  }
  return 'in-policy';
}

export function remainingTargets(targets: RotationTarget[]): RotationTarget[] {
  return targets.filter((t) => t.phase !== 'on_new_psk' && t.phase !== 'retired');
}
