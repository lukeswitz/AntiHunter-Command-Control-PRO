import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import {
  channelHash,
  decodeKeyB64,
  encodeKeyB64,
  fingerprint,
  generatePskAvoidingCollision,
  keyPairMatches,
  validatePsk,
  validateX25519PublicKey,
} from './fleet-crypto';
import {
  computeDrift,
  nextRetryPhase,
  pickRecoverySlot,
  pickStagingSlot,
  retireGate,
} from './fleet-rotation';
import { FleetStore, IdentityRole, RotationTarget } from './fleet-store';
import { EventBusService } from '../events/event-bus.service';
import { PrismaService } from '../prisma/prisma.service';
import { RadioReKeyRefused } from '../serial/fleet-admin.types';
import { SerialService } from '../serial/serial.service';

const WORKER_POLL_MS = 2000;
const PRIMARY_INDEX = 0;
const COMMIT_SETTLE_MS = 12_000;

export interface IdentityView {
  fingerprint: string;
  label?: string;
  role?: string;
  source?: string;
}

@Injectable()
export class FleetSecService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FleetSecService.name);
  private worker?: NodeJS.Timeout;
  private workerBusy = false;
  private readonly workerId = `ahcc-${process.pid}`;

  constructor(
    private readonly store: FleetStore,
    private readonly serial: SerialService,
    private readonly events: EventBusService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    if (!this.serial.ownsPort()) {
      return;
    }
    this.worker = setInterval(() => void this.tickWorker(), WORKER_POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.worker) {
      clearInterval(this.worker);
    }
  }

  private localNum(): number {
    const num = this.serial.getLocalRadio().num;
    if (!num) {
      throw new BadRequestException('Radio not identified yet. Open the Radio card and Refresh.');
    }
    return num;
  }

  private async audit(
    userId: string | undefined,
    action: string,
    resourceId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          userId: userId ?? null,
          action: `fleetsec.${action}`,
          entity: 'FleetSecurity',
          entityId: resourceId,
          before: undefined,
          after: this.redact(details) as object,
        },
      })
      .catch((error) => this.logger.warn(`audit ${action}: ${error}`));
  }

  private redact(details: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(details)) {
      out[k] = ['psk', 'privateKey', 'privkey', 'secret'].includes(k) ? '<redacted>' : v;
    }
    return out;
  }

  // --- identity ---
  async getIdentity(userId?: string): Promise<IdentityView> {
    const sec = await this.serial.fleetGetSecurity(this.localNum());
    validateX25519PublicKey(sec.publicKey);
    const fp = fingerprint(sec.publicKey);
    const existing = await this.store.getIdentityByFingerprint(fp);
    if (existing) {
      return {
        fingerprint: fp,
        label: existing.label,
        role: existing.role,
        source: existing.source,
      };
    }
    const created = await this.store.insertIdentity({
      label: `local-radio-${fp.slice(0, 5)}`,
      publicKey: sec.publicKey,
      fingerprint: fp,
      role: 'primary',
      source: 'auto-generated',
    });
    await this.audit(userId, 'auto_register_local', fp, { label: created.label });
    return { fingerprint: fp, label: created.label, role: created.role, source: created.source };
  }

  async listIdentities() {
    const rows = await this.store.listIdentities();
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      fingerprint: r.fingerprint,
      role: r.role,
      source: r.source,
      createdAt: r.createdAt,
      revokedAt: r.revokedAt,
      revokedReason: r.revokedReason,
    }));
  }

  async registerIdentity(userId: string, label: string, publicKeyB64: string, role: IdentityRole) {
    if (!['primary', 'rescue', 'operator'].includes(role)) {
      throw new BadRequestException('invalid role');
    }
    const pub = decodeKeyB64(publicKeyB64);
    validateX25519PublicKey(pub);
    const rec = await this.store.insertIdentity({
      label,
      publicKey: pub,
      fingerprint: fingerprint(pub),
      role,
      source: 'imported',
    });
    await this.audit(userId, 'register_identity', rec.fingerprint, { label, role });
    return { id: rec.id, fingerprint: rec.fingerprint };
  }

  async importIdentity(userId: string, label: string, privB64: string, pubB64: string) {
    const priv = decodeKeyB64(privB64);
    const pub = decodeKeyB64(pubB64);
    validateX25519PublicKey(pub);
    if (!keyPairMatches(priv, pub)) {
      throw new BadRequestException('private key does not match the public key');
    }
    await this.serial.fleetSetSecurity(this.localNum(), { publicKey: pub, privateKey: priv });
    priv.fill(0);
    const rec = await this.store.insertIdentity({
      label,
      publicKey: pub,
      fingerprint: fingerprint(pub),
      role: 'primary',
      source: 'imported',
    });
    await this.audit(userId, 'import_identity', rec.fingerprint, { label });
    return { id: rec.id, fingerprint: rec.fingerprint };
  }

  async revokeIdentity(userId: string, fp: string, reason: string) {
    const existing = await this.store.getIdentityByFingerprint(fp);
    if (!existing) {
      throw new NotFoundException('identity not found');
    }
    await this.store.revokeIdentity(fp, reason);
    await this.audit(userId, 'revoke_identity', fp, { reason });
    return { ok: true };
  }

  async exportPubkey(): Promise<{ publicKey: string; fingerprint: string }> {
    const sec = await this.serial.fleetGetSecurity(this.localNum());
    return { publicKey: encodeKeyB64(sec.publicKey), fingerprint: fingerprint(sec.publicKey) };
  }

  // --- trust ---
  async listTrust() {
    const [rows, policy, names] = await Promise.all([
      this.store.listNodeTrust(),
      this.store.getPolicy(),
      Promise.resolve(this.serial.getMeshNodeNames()),
    ]);
    const localNum = this.serial.getLocalRadio().num;
    if (localNum === undefined) {
      return [];
    }
    const known = new Set(rows.map((r) => r.nodeNum));
    const unverified = Array.from(names.entries())
      .filter(([nodeNum]) => !known.has(nodeNum) && nodeNum !== localNum)
      .map(([nodeNum, name]) => ({
        nodeNum,
        name,
        adminKeyFingerprints: [] as string[],
        isManaged: false,
        lastVerifiedAt: null,
        lastVerifyMethod: null,
        currentPskFp: null,
        strandedSince: null,
        driftStatus: 'unknown' as const,
      }));
    return [
      ...rows
        .filter((r) => r.nodeNum !== localNum)
        .map((r) => ({
          nodeNum: r.nodeNum,
          name: names.get(r.nodeNum) ?? `!${r.nodeNum.toString(16)}`,
          adminKeyFingerprints: r.adminKeyFps,
          isManaged: r.isManaged,
          lastVerifiedAt: r.lastVerifiedAt,
          lastVerifyMethod: r.lastVerifyMethod,
          currentPskFp: r.currentPskFp,
          strandedSince: r.strandedSince,
          driftStatus: computeDrift(r, policy),
        })),
      ...unverified,
    ];
  }

  async verifyTrust(userId: string, nodeNum: number) {
    if (!nodeNum) {
      throw new BadRequestException('nodeNum required');
    }
    const isLocal = nodeNum === this.serial.getLocalRadio().num;
    try {
      const sec = await this.serial.fleetGetSecurity(nodeNum);
      const now = new Date();
      const policy = await this.store.getPolicy();
      const adminKeyFps = sec.adminKeys.map((k) => fingerprint(k));
      const drift = computeDrift(
        { driftStatus: 'unknown', lastVerifiedAt: now, isManaged: sec.isManaged, adminKeyFps },
        policy,
      );
      await this.store.upsertNodeTrust({
        nodeNum,
        adminKeyFps,
        isManaged: sec.isManaged,
        lastVerifiedAt: now,
        lastVerifyMethod: isLocal ? 'local-usb' : 'remote-pkc',
        lastDriftCheckAt: now,
        driftStatus: drift,
      });
      const localPrimaryFp = await this.localPrimaryPskFp();
      if (localPrimaryFp) {
        await this.store.setNodeCurrentPskFp(nodeNum, localPrimaryFp).catch(() => undefined);
      }
      await this.audit(userId, 'verify_trust', String(nodeNum), {
        ok: true,
        isManaged: sec.isManaged,
        adminKeyFingerprints: adminKeyFps,
        driftStatus: drift,
      });
      return {
        nodeNum,
        ok: true,
        isManaged: sec.isManaged,
        adminKeyFingerprints: adminKeyFps,
        driftStatus: drift,
      };
    } catch (error) {
      await this.store.markNodeUnreachable(nodeNum, new Date());
      await this.audit(userId, 'verify_trust', String(nodeNum), { ok: false, error: `${error}` });
      return { nodeNum, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setAdminKeys(userId: string, nodeNum: number, keyFps: string[]) {
    if (keyFps.length > 3) {
      throw new BadRequestException('admin_key list cannot exceed 3 entries');
    }
    const pubs: Buffer[] = [];
    for (const fp of keyFps) {
      const rec = await this.store.getIdentityByFingerprint(fp);
      if (!rec) {
        throw new BadRequestException(`unknown fingerprint ${fp}`);
      }
      pubs.push(rec.publicKey);
    }
    try {
      await this.serial.fleetSetSecurity(nodeNum, { adminKeys: pubs });
    } catch (error) {
      if (error instanceof RadioReKeyRefused) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    await this.audit(userId, 'set_admin_keys', String(nodeNum), { keyFingerprints: keyFps });
    return { ok: true };
  }

  async setIsManaged(userId: string, nodeNum: number, value: boolean) {
    try {
      await this.serial.fleetSetSecurity(nodeNum, { isManaged: value });
    } catch (error) {
      if (error instanceof RadioReKeyRefused) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    await this.audit(userId, 'set_is_managed', String(nodeNum), { value });
    return { ok: true };
  }

  async getPolicy() {
    return this.store.getPolicy();
  }

  async setPolicy(
    userId: string,
    patch: { expectedAdminKeyFps?: string[]; expectedIsManaged?: boolean },
  ) {
    await this.store.setPolicy(patch, userId);
    await this.audit(userId, 'set_policy', 'policy', patch);
    return this.store.getPolicy();
  }

  // --- channels ---
  async listChannels() {
    return this.store.listChannels();
  }

  async refreshChannels(userId: string) {
    for (let idx = 0; idx < 8; idx += 1) {
      try {
        const ch = await this.serial.fleetGetChannel(this.localNum(), idx);
        await this.store.upsertChannel({
          channelIndex: idx,
          name: ch.name,
          role: ch.role,
          pskFingerprint: ch.psk.length ? fingerprint(ch.psk) : null,
          pskLength: ch.psk.length,
        });
      } catch {
        // slot never written / unreadable — skip
      }
    }
    await this.audit(userId, 'refresh_channels', 'channels', {});
    return this.store.listChannels();
  }

  private async localPrimaryPskFp(): Promise<string | null> {
    const channels = await this.store.listChannels();
    const primary = channels.find((c) => c.channelIndex === PRIMARY_INDEX);
    return primary?.pskFingerprint ?? null;
  }

  // --- PSK rotation ---
  async rotatePsk(
    userId: string,
    channelIndex: number,
    pskB64: string | null,
    targets: number[],
    ack: string,
    notes: string,
  ) {
    if (ack !== 'ROTATE') {
      throw new BadRequestException('PSK rotation requires ack="ROTATE"');
    }
    const recovery = await this.store.listRecoveryPsks();
    const usedHashes = new Set(recovery.map((r) => r.pskHash));
    const channels = await this.store.listChannels();
    for (const c of channels) {
      if (c.pskFingerprint && c.role !== 'DISABLED') {
        // include current channel hashes when we know the psk length only via fp — skip (fp != hash)
      }
    }
    let psk: Buffer;
    if (pskB64) {
      psk = decodeKeyB64(pskB64);
      validatePsk(psk);
      if (usedHashes.has(channelHash('', psk))) {
        throw new BadRequestException('PSK collides with a recovery channel hash; pick another');
      }
    } else {
      psk = generatePskAvoidingCollision(16, usedHashes);
    }
    const seen = new Set<number>();
    const rotationTargets: RotationTarget[] = [];
    for (const t of targets) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      rotationTargets.push({ nodeNum: t, phase: 'pending', attempts: 0 });
    }
    if (rotationTargets.length === 0) {
      throw new BadRequestException('no valid targets');
    }
    const newPskFp = fingerprint(psk);
    const id = await this.store.insertRotation(
      { kind: 'psk', channelIndex, startedBy: userId, targets: rotationTargets, newPskFp, notes },
      psk,
    );
    psk.fill(0);
    await this.store.enqueueJob('rotate_phase_a', id, {});
    await this.audit(userId, 'rotate_psk_start', String(channelIndex), {
      rotationId: id,
      targetCount: rotationTargets.length,
      newPskFp,
    });
    return { rotationId: id, newPskFingerprint: newPskFp, targetCount: rotationTargets.length };
  }

  async getRotation(id: string) {
    const rec = await this.store.getRotation(id);
    if (!rec) throw new NotFoundException('rotation not found');
    return rec;
  }

  async retireOldPsk(userId: string, rotId: string) {
    const rec = await this.store.getRotation(rotId);
    if (!rec) throw new NotFoundException('rotation not found');
    if (rec.retiredAt || rec.piLocalPhase === 'retired') {
      throw new BadRequestException('rotation already retired');
    }
    if (rec.piLocalPhase !== 'staging_added') {
      throw new BadRequestException(`rotation not ready to retire (phase=${rec.piLocalPhase})`);
    }
    const managed = (await this.store.listNodeTrust()).filter((n) => n.isManaged);
    const gate = retireGate(managed, rec.newPskFp ?? '');
    if (!gate.ok) {
      await this.audit(userId, 'rotate_psk_retire_blocked', rotId, { laggards: gate.laggards });
      return { ok: false, laggards: gate.laggards };
    }
    await this.store.enqueueJob('rotate_phase_c', rotId, {});
    await this.audit(userId, 'rotate_psk_retire', rotId, {});
    return { ok: true };
  }

  // --- job worker ---
  private async tickWorker(): Promise<void> {
    if (this.workerBusy) return;
    this.workerBusy = true;
    try {
      const job = await this.store.claimNextJob(this.workerId);
      if (!job) return;
      try {
        if (job.kind === 'rotate_phase_a' && job.rotationId) {
          await this.runPhaseA(job.rotationId);
        } else if (job.kind === 'rotate_phase_b' && job.rotationId) {
          await this.runPhaseB(job.rotationId, Number(job.payload.nodeNum));
        } else if (job.kind === 'rotate_phase_c' && job.rotationId) {
          await this.runPhaseC(job.rotationId);
        }
        await this.store.finishJob(job.id, 'done');
      } catch (error) {
        await this.store.finishJob(
          job.id,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
        this.logger.warn(`fleet job ${job.kind} failed: ${error}`);
      }
    } catch (error) {
      this.logger.warn(`fleet worker tick: ${error}`);
    } finally {
      this.workerBusy = false;
    }
  }

  private broadcastRotation(rotationId: string): void {
    this.events.publish({ type: 'event.fleet-rotation', rotationId });
  }

  private async runPhaseA(rotationId: string): Promise<void> {
    const rec = await this.store.getRotation(rotationId);
    if (!rec) return;
    const local = this.localNum();
    const empty: number[] = [];
    let primaryIdx = -1;
    let primaryPsk: Buffer | null = null;
    for (let idx = 0; idx < 8; idx += 1) {
      try {
        const ch = await this.serial.fleetGetChannel(local, idx);
        if (ch.role === 'PRIMARY') {
          primaryIdx = idx;
          primaryPsk = ch.psk;
        } else if (ch.role === 'DISABLED') {
          empty.push(idx);
        }
      } catch {
        // unknown slot
      }
    }
    if (primaryIdx < 0) {
      throw new Error('no PRIMARY channel found on local radio');
    }
    const stagingIdx = pickStagingSlot(empty, primaryIdx);
    const psk = await this.store.getRotationPsk(rotationId);
    if (!psk) throw new Error('rotation PSK missing');
    await this.serial.fleetSetChannelLocal({ index: stagingIdx, name: '', role: 'SECONDARY', psk });
    // stash the OLD primary psk for stranded-node recovery
    if (primaryPsk && primaryPsk.length) {
      const recovery = await this.store.listRecoveryPsks();
      const slot = pickRecoverySlot(recovery.map((r) => r.slot));
      await this.store.upsertRecoveryPsk({
        slot,
        fp: fingerprint(primaryPsk),
        rawPsk: primaryPsk,
        pskHash: channelHash('', primaryPsk),
        rotationId,
      });
    }
    await this.store.setRotationStaging(rotationId, stagingIdx, 'staging_added');
    for (const t of rec.targets) {
      if (t.nodeNum !== local) {
        await this.store.enqueueJob('rotate_phase_b', rotationId, { nodeNum: t.nodeNum });
      }
    }
    psk.fill(0);
    this.broadcastRotation(rotationId);
  }

  private async runPhaseB(rotationId: string, nodeNum: number): Promise<void> {
    const rec = await this.store.getRotation(rotationId);
    if (!rec || rec.stagingChannelIndex === null) throw new Error('rotation not staged');
    const psk = await this.store.getRotationPsk(rotationId);
    if (!psk) throw new Error('rotation PSK missing');
    const stagingIdx = rec.stagingChannelIndex;
    const newFp = rec.newPskFp ?? '';
    const targets = rec.targets.map((t) =>
      t.nodeNum === nodeNum ? { ...t, phase: 'phase_b_pushing' as const } : t,
    );
    await this.store.updateRotationTargets(rotationId, targets, null);
    this.broadcastRotation(rotationId);
    try {
      await this.serial.fleetEstablishSession(nodeNum);
      await this.serial.fleetFireForget(nodeNum, { t: 'beginEdit' });
      await this.serial.fleetFireForget(nodeNum, {
        t: 'setChannel',
        channel: { index: stagingIdx, name: '', role: 'PRIMARY', psk },
      });
      await this.serial.fleetFireForget(nodeNum, {
        t: 'setChannel',
        channel: { index: PRIMARY_INDEX, name: '', role: 'DISABLED', psk: Buffer.alloc(0) },
      });
      await this.serial.fleetFireForget(nodeNum, { t: 'commitEdit' });
      await new Promise((r) => setTimeout(r, COMMIT_SETTLE_MS));
      const verify = await this.serial.fleetGetChannel(nodeNum, stagingIdx);
      if (verify.role !== 'PRIMARY' || fingerprint(verify.psk) !== newFp) {
        throw new Error('post-commit verify failed');
      }
      const done = rec.targets.map((t) =>
        t.nodeNum === nodeNum ? { ...t, phase: 'on_new_psk' as const } : t,
      );
      await this.store.updateRotationTargets(rotationId, done, null);
      await this.store.setNodeCurrentPskFp(nodeNum, newFp).catch(() => undefined);
    } catch (error) {
      const failed = rec.targets.map((t) =>
        t.nodeNum === nodeNum
          ? { ...t, phase: 'failed_b' as const, lastError: `${error}`, attempts: t.attempts + 1 }
          : t,
      );
      await this.store.updateRotationTargets(rotationId, failed, null);
      throw error;
    } finally {
      psk.fill(0);
      this.broadcastRotation(rotationId);
    }
  }

  private async runPhaseC(rotationId: string): Promise<void> {
    const rec = await this.store.getRotation(rotationId);
    if (!rec || rec.stagingChannelIndex === null) throw new Error('rotation not staged');
    const psk = await this.store.getRotationPsk(rotationId);
    if (!psk) throw new Error('rotation PSK missing');
    const stagingIdx = rec.stagingChannelIndex;
    await this.serial.fleetLocalAdmin({ t: 'beginEdit' });
    await this.serial.fleetSetChannelLocal({ index: stagingIdx, name: '', role: 'PRIMARY', psk });
    await this.serial.fleetSetChannelLocal({
      index: PRIMARY_INDEX,
      name: '',
      role: 'DISABLED',
      psk: Buffer.alloc(0),
    });
    await this.serial.fleetLocalAdmin({ t: 'commitEdit' });
    await this.store.upsertChannel({
      channelIndex: stagingIdx,
      name: '',
      role: 'PRIMARY',
      pskFingerprint: rec.newPskFp,
      pskLength: psk.length,
      lastRotatedAt: new Date(),
      lastRotationId: rotationId,
    });
    await this.store.markRotationRetired(rotationId);
    await this.store.clearRotationPsk(rotationId);
    psk.fill(0);
    this.broadcastRotation(rotationId);
  }

  async retryRotation(userId: string, rotId: string, targetNodeNums: number[]) {
    const rec = await this.store.getRotation(rotId);
    if (!rec) throw new NotFoundException('rotation not found');
    const want = new Set(targetNodeNums);
    let any = false;
    const targets = rec.targets.map((t) => {
      if (!want.has(t.nodeNum)) return t;
      const next = nextRetryPhase(t.phase);
      if (next === null) return t;
      any = true;
      return { ...t, phase: next, lastError: undefined };
    });
    if (!any) {
      throw new BadRequestException('no eligible targets to retry');
    }
    await this.store.updateRotationTargets(rotId, targets, null);
    await this.store.enqueueJob('rotate_phase_a', rotId, {});
    await this.audit(userId, 'rotate_psk_retry', rotId, { targetCount: targetNodeNums.length });
    return { ok: true };
  }

  // guard for controllers: fleet security only works on the port owner
  ensurePortOwner(): void {
    if (!this.serial.ownsPort()) {
      throw new ForbiddenException('Fleet security runs on the node with the serial port');
    }
  }
}
