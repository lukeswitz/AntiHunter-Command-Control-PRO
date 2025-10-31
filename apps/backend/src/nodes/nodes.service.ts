import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

import { NodeDiff, NodeSnapshot } from './nodes.types';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NodesService implements OnModuleInit {
  private readonly logger = new Logger(NodesService.name);
  private readonly nodes = new Map<string, NodeSnapshot>();
  private readonly snapshot$ = new BehaviorSubject<NodeSnapshot[]>([]);
  private readonly diff$ = new Subject<NodeDiff>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const records = await this.prisma.node.findMany({
      include: {
        positions: {
          orderBy: { ts: 'desc' },
          take: 1,
        },
        site: {
          select: { id: true, name: true, color: true },
        },
      },
    });

    records.forEach((record) => {
      const snapshot = this.buildSnapshot(record);
      this.nodes.set(snapshot.id, snapshot);
    });

    this.emitSnapshot();
    this.logger.log(`Loaded ${records.length} nodes into snapshot cache`);
  }

  async upsert(snapshot: NodeSnapshot): Promise<void> {
    const now = snapshot.ts ?? new Date();
    const lat = this.toNumber(snapshot.lat);
    const lon = this.toNumber(snapshot.lon);

    await this.prisma.$transaction(async (tx) => {
      await tx.node.upsert({
        where: { id: snapshot.id },
        create: {
          id: snapshot.id,
          name: snapshot.name ?? undefined,
          lastMessage: snapshot.lastMessage ?? undefined,
          lastSeen: snapshot.lastSeen ?? now,
          siteId: snapshot.siteId ?? undefined,
        },
        update: {
          name: snapshot.name ?? undefined,
          lastMessage: snapshot.lastMessage ?? undefined,
          lastSeen: snapshot.lastSeen ?? now,
          siteId: snapshot.siteId ?? undefined,
        },
      });

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        await tx.nodePosition.create({
          data: {
            nodeId: snapshot.id,
            lat,
            lon,
            ts: now,
          },
        });
      }
    });

    const existing = this.nodes.get(snapshot.id);
    let siteName = snapshot.siteName;
    let siteColor = snapshot.siteColor;
    if (snapshot.siteId && (!siteName || !siteColor)) {
      const site = await this.prisma.site.findUnique({
        where: { id: snapshot.siteId },
        select: { name: true, color: true },
      });
      siteName = site?.name ?? siteName;
      siteColor = site?.color ?? siteColor;
    }
    const merged: NodeSnapshot = {
      ...existing,
      ...snapshot,
      lat,
      lon,
      ts: now,
      lastSeen: snapshot.lastSeen ?? now,
      siteId: snapshot.siteId ?? existing?.siteId,
      siteName: siteName ?? existing?.siteName,
      siteColor: siteColor ?? existing?.siteColor,
    };

    this.nodes.set(snapshot.id, merged);
    this.diff$.next({ type: 'upsert', node: merged });
    this.emitSnapshot();
  }

  async remove(nodeId: string): Promise<void> {
    const existing = this.nodes.get(nodeId);
    if (!existing) {
      return;
    }

    await this.prisma.node.update({
      where: { id: nodeId },
      data: {
        lastSeen: existing.lastSeen ?? new Date(),
      },
    });

    this.nodes.delete(nodeId);
    this.diff$.next({ type: 'remove', node: existing });
    this.emitSnapshot();
  }

  async clearAll(): Promise<{ removed: number }> {
    const snapshots = Array.from(this.nodes.values());

    const removedCount = await this.prisma.$transaction(async (tx) => {
      await tx.triangulationResult.deleteMany();
      await tx.nodePosition.deleteMany();
      await tx.nodeCoverageOverride.deleteMany();
      const deleted = await tx.node.deleteMany();
      return deleted.count;
    });

    snapshots.forEach((snapshot) => {
      this.diff$.next({ type: 'remove', node: snapshot });
    });
    this.nodes.clear();
    this.emitSnapshot();

    this.logger.log(`Cleared ${removedCount} nodes from database and cache`);
    return { removed: removedCount };
  }

  getSnapshot(): NodeSnapshot[] {
    return this.snapshot$.value;
  }

  getSnapshotStream(): Observable<NodeSnapshot[]> {
    return this.snapshot$.asObservable();
  }

  getDiffStream(): Observable<NodeDiff> {
    return this.diff$.asObservable();
  }

  async updateLastMessage(nodeId: string, message: string, lastSeen?: Date): Promise<void> {
    const existing = this.nodes.get(nodeId);
    if (!existing) {
      return;
    }

    const timestamp = lastSeen ?? new Date();
    const updated: NodeSnapshot = {
      ...existing,
      lastMessage: message,
      lastSeen: timestamp,
    };

    try {
      await this.prisma.node.upsert({
        where: { id: nodeId },
        create: {
          id: nodeId,
          name: existing.name ?? undefined,
          lastMessage: message,
          lastSeen: timestamp,
          siteId: existing.siteId ?? undefined,
        },
        update: {
          lastMessage: message,
          lastSeen: timestamp,
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to persist last message for node ${nodeId}: ${String(error)}`);
    }

    this.nodes.set(nodeId, updated);
    this.diff$.next({ type: 'upsert', node: updated });
    this.emitSnapshot();
  }

  getSnapshotById(nodeId: string): NodeSnapshot | undefined {
    return this.nodes.get(nodeId);
  }

  private emitSnapshot(): void {
    this.snapshot$.next(Array.from(this.nodes.values()));
  }

  private buildSnapshot(node: {
    id: string;
    name: string | null;
    lastMessage: string | null;
    lastSeen: Date | null;
    positions: Array<{ lat: number; lon: number; ts: Date }>;
    site?: { id: string; name: string | null; color: string | null } | null;
  }): NodeSnapshot {
    const lastPosition = node.positions.at(0);
    return {
      id: node.id,
      name: node.name ?? undefined,
      lat: this.toNumber(lastPosition?.lat),
      lon: this.toNumber(lastPosition?.lon),
      ts: lastPosition?.ts ?? node.lastSeen ?? new Date(),
      lastMessage: node.lastMessage ?? undefined,
      lastSeen: node.lastSeen ?? undefined,
      siteId: node.site?.id ?? undefined,
      siteName: node.site?.name ?? undefined,
      siteColor: node.site?.color ?? undefined,
    };
  }

  private toNumber(value: number | string | null | undefined): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }
}
