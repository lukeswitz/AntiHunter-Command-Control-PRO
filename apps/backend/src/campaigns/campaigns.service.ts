import { Injectable, NotFoundException } from '@nestjs/common';
import { CampaignRun } from '@prisma/client';

import { classifyInventoryDevice } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';

const LIST_LIMIT = 50;
const VISIT_LIMIT = 20_000;

interface OpenRun {
  id: string;
  name: string;
}

interface RunWindow {
  nodeId: string;
  start: Date;
  end: Date;
}

export interface CampaignSummary {
  name: string;
  active: boolean;
  startedAt: string;
  endedAt: string | null;
  nodes: string[];
  devices: number;
}

@Injectable()
export class CampaignsService {
  private readonly openByNode = new Map<string, OpenRun | null>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  reconcile(nodeId: string, name: string | null, siteId?: string | null): Promise<void> {
    const task = this.queue.then(() => this.apply(nodeId, name, siteId ?? null));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async apply(nodeId: string, name: string | null, siteId: string | null): Promise<void> {
    const open = await this.openRun(nodeId);
    if ((open?.name ?? null) === name) {
      return;
    }
    const now = new Date();
    if (open) {
      await this.prisma.campaignRun.update({ where: { id: open.id }, data: { endedAt: now } });
    }
    if (!name) {
      this.openByNode.set(nodeId, null);
      return;
    }
    const run = await this.prisma.campaignRun.create({
      data: { name, nodeId, siteId, startedAt: now },
    });
    this.openByNode.set(nodeId, { id: run.id, name });
  }

  private async openRun(nodeId: string): Promise<OpenRun | null> {
    const cached = this.openByNode.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    const run = await this.prisma.campaignRun.findFirst({
      where: { nodeId, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    const open = run ? { id: run.id, name: run.name } : null;
    this.openByNode.set(nodeId, open);
    return open;
  }

  async list(): Promise<CampaignSummary[]> {
    const runs = await this.prisma.campaignRun.findMany({ orderBy: { startedAt: 'desc' } });
    const byName = new Map<string, CampaignRun[]>();
    for (const run of runs) {
      const group = byName.get(run.name) ?? [];
      group.push(run);
      byName.set(run.name, group);
    }
    const summaries = Array.from(byName.entries()).map(([name, group]) =>
      this.summarize(name, group),
    );
    summaries.sort(
      (a, b) => Number(b.active) - Number(a.active) || b.startedAt.localeCompare(a.startedAt),
    );
    const top = summaries.slice(0, LIST_LIMIT);
    await Promise.all(
      top.map(async (summary) => {
        const visits = await this.visitsFor(this.windows(byName.get(summary.name) ?? []), {
          mac: true,
        });
        summary.devices = new Set(visits.map((visit) => visit.mac)).size;
      }),
    );
    return top;
  }

  async detail(name: string) {
    const runs = await this.prisma.campaignRun.findMany({
      where: { name },
      orderBy: { startedAt: 'asc' },
    });
    if (runs.length === 0) {
      throw new NotFoundException(`Campaign ${name} not found`);
    }
    const visits = await this.visitsFor(this.windows(runs), {
      mac: true,
      start: true,
      end: true,
      hits: true,
      nodeId: true,
    });
    const byMac = new Map<
      string,
      { hits: number; firstSeen: Date; lastSeen: Date; nodes: Set<string> }
    >();
    for (const visit of visits) {
      const entry = byMac.get(visit.mac) ?? {
        hits: 0,
        firstSeen: visit.start,
        lastSeen: visit.end,
        nodes: new Set<string>(),
      };
      entry.hits += visit.hits;
      if (visit.start < entry.firstSeen) entry.firstSeen = visit.start;
      if (visit.end > entry.lastSeen) entry.lastSeen = visit.end;
      if (visit.nodeId) entry.nodes.add(visit.nodeId);
      byMac.set(visit.mac, entry);
    }
    const inventory = await this.prisma.inventoryDevice.findMany({
      where: { mac: { in: Array.from(byMac.keys()) } },
    });
    const inventoryByMac = new Map(inventory.map((device) => [device.mac, device]));
    const devices = Array.from(byMac.entries())
      .map(([mac, entry]) => {
        const device = inventoryByMac.get(mac);
        return {
          mac,
          hits: entry.hits,
          firstSeen: entry.firstSeen.toISOString(),
          lastSeen: entry.lastSeen.toISOString(),
          nodes: Array.from(entry.nodes),
          vendor: device?.vendor ?? null,
          type: device?.type ?? null,
          ssid: device?.ssid ?? null,
          maxRSSI: device?.maxRSSI ?? null,
          classification: device ? classifyInventoryDevice(device) : null,
        };
      })
      .sort((a, b) => b.hits - a.hits);
    return {
      ...this.summarize(name, runs),
      devices: devices.length,
      runs: runs.map((run) => ({
        nodeId: run.nodeId,
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString() ?? null,
      })),
      deviceList: devices,
    };
  }

  async remove(name: string): Promise<{ deleted: number }> {
    const result = await this.prisma.campaignRun.deleteMany({ where: { name } });
    this.openByNode.clear();
    return { deleted: result.count };
  }

  private summarize(name: string, runs: CampaignRun[]): CampaignSummary {
    const active = runs.some((run) => run.endedAt === null);
    const startedAt = runs.reduce(
      (min, run) => (run.startedAt < min ? run.startedAt : min),
      runs[0].startedAt,
    );
    const endedAt = active
      ? null
      : runs.reduce<Date | null>(
          (max, run) => (run.endedAt && (!max || run.endedAt > max) ? run.endedAt : max),
          null,
        );
    return {
      name,
      active,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt?.toISOString() ?? null,
      nodes: Array.from(new Set(runs.map((run) => run.nodeId))),
      devices: 0,
    };
  }

  private windows(runs: CampaignRun[]): RunWindow[] {
    const now = new Date();
    return runs.map((run) => ({
      nodeId: run.nodeId,
      start: run.startedAt,
      end: run.endedAt ?? now,
    }));
  }

  private visitsFor<S extends Record<string, true>>(windows: RunWindow[], select: S) {
    return this.prisma.deviceVisit.findMany({
      where: {
        OR: windows.map((window) => ({
          nodeId: window.nodeId,
          start: { lte: window.end },
          end: { gte: window.start },
        })),
      },
      select,
      take: VISIT_LIMIT,
    });
  }
}
