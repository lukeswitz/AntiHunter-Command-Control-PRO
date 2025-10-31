import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { OuiService } from '../oui/oui.service';
import { PrismaService } from '../prisma/prisma.service';
import { SerialTargetDetected } from '../serial/serial.types';
import { normalizeMac } from '../utils/mac';

interface ListOptions {
  search?: string;
  limit?: number;
}

interface PromoteTargetOptions {
  name?: string;
  notes?: string;
  tags?: string[];
  siteId?: string;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ouiService: OuiService,
  ) {}

  async recordDetection(
    event: SerialTargetDetected,
    siteId?: string | null,
    fallbackLat?: number | null,
    fallbackLon?: number | null,
  ): Promise<void> {
    let normalizedMac: string;
    try {
      normalizedMac = normalizeMac(event.mac);
    } catch {
      this.logger.warn(`Skipping inventory update for invalid MAC: ${event.mac}`);
      return;
    }

    const now = new Date();
    const existingRecord = await this.prisma.inventoryDevice.findUnique({
      where: { mac: normalizedMac },
    });
    const existing = existingRecord as (typeof existingRecord & { ssid?: string | null }) | null;

    const hits = (existing?.hits ?? 0) + 1;
    const rssi = typeof event.rssi === 'number' ? event.rssi : undefined;
    const ssid = event.name?.trim() ? event.name.trim() : undefined;
    const eventLat = this.toFinite(event.lat);
    const eventLon = this.toFinite(event.lon);
    const fallbackLatValue = this.toFinite(fallbackLat);
    const fallbackLonValue = this.toFinite(fallbackLon);
    const canUseFallback =
      fallbackLatValue !== undefined &&
      fallbackLonValue !== undefined &&
      (fallbackLatValue !== 0 || fallbackLonValue !== 0);
    const latCandidate = eventLat ?? (canUseFallback ? fallbackLatValue : undefined);
    const lonCandidate = eventLon ?? (canUseFallback ? fallbackLonValue : undefined);
    const lastNodeId = event.nodeId ?? existing?.lastNodeId ?? undefined;

    const ouiInfo = await this.ouiService.resolve(normalizedMac);
    const vendor = ouiInfo.vendor ?? existing?.vendor ?? undefined;
    const locallyAdministered = ouiInfo.locallyAdministered;
    const multicast = ouiInfo.multicast;

    let maxRSSI = existing?.maxRSSI ?? rssi ?? null;
    let minRSSI = existing?.minRSSI ?? rssi ?? null;
    let avgRSSI = existing?.avgRSSI ?? rssi ?? null;

    if (typeof rssi === 'number') {
      maxRSSI = maxRSSI !== null ? Math.max(maxRSSI, rssi) : rssi;
      minRSSI = minRSSI !== null ? Math.min(minRSSI, rssi) : rssi;
      if (existing?.avgRSSI != null) {
        avgRSSI = Number(((existing.avgRSSI * (existing.hits ?? 0) + rssi) / hits).toFixed(2));
      } else {
        avgRSSI = rssi;
      }
    }

    await this.prisma.inventoryDevice.upsert({
      where: { mac: normalizedMac },
      create: {
        mac: normalizedMac,
        vendor,
        type: event.type,
        ssid,
        hits,
        lastSeen: now,
        maxRSSI: maxRSSI ?? undefined,
        minRSSI: minRSSI ?? undefined,
        avgRSSI: avgRSSI ?? undefined,
        locallyAdministered,
        multicast,
        lastNodeId,
        lastLat: latCandidate ?? undefined,
        lastLon: lonCandidate ?? undefined,
        siteId: siteId ?? undefined,
      } as Prisma.InventoryDeviceUncheckedCreateInput,
      update: {
        vendor: vendor ?? existing?.vendor,
        type: event.type ?? existing?.type,
        ssid: ssid ?? existing?.ssid ?? undefined,
        hits,
        lastSeen: now,
        maxRSSI: maxRSSI ?? existing?.maxRSSI ?? undefined,
        minRSSI: minRSSI ?? existing?.minRSSI ?? undefined,
        avgRSSI: avgRSSI ?? existing?.avgRSSI ?? undefined,
        locallyAdministered,
        multicast,
        lastNodeId,
        lastLat: latCandidate ?? existing?.lastLat ?? undefined,
        lastLon: lonCandidate ?? existing?.lastLon ?? undefined,
        siteId: siteId ?? existing?.siteId ?? undefined,
      } as Prisma.InventoryDeviceUncheckedUpdateInput,
    });
  }

  async listDevices(options: ListOptions = {}) {
    const where: Prisma.InventoryDeviceWhereInput | undefined = options.search
      ? {
          OR: [
            {
              mac: { contains: options.search, mode: Prisma.QueryMode.insensitive },
            },
            {
              vendor: { contains: options.search, mode: Prisma.QueryMode.insensitive },
            },
            {
              type: { contains: options.search, mode: Prisma.QueryMode.insensitive },
            },
            {
              ssid: { contains: options.search, mode: Prisma.QueryMode.insensitive },
            } as Prisma.InventoryDeviceWhereInput,
          ],
        }
      : undefined;

    return this.prisma.inventoryDevice.findMany({
      where,
      orderBy: [{ hits: 'desc' }, { lastSeen: 'desc' }],
      take: options.limit ?? 200,
    });
  }

  async promoteToTarget(mac: string, options: PromoteTargetOptions = {}) {
    let normalizedMac: string;
    try {
      normalizedMac = normalizeMac(mac);
    } catch {
      throw new BadRequestException('mac must be a valid 6-byte address');
    }

    const device = await this.prisma.inventoryDevice.findUnique({
      where: { mac: normalizedMac },
    });

    if (!device) {
      throw new NotFoundException(`No inventory record found for ${normalizedMac}`);
    }

    let lat = this.toFinite(device.lastLat);
    let lon = this.toFinite(device.lastLon);
    let firstNodeId = device.lastNodeId ?? undefined;

    const coordinatesMayBePlaceholder =
      lat === undefined ||
      lon === undefined ||
      (lat === 0 && lon === 0 && (device.lastLat == null || device.lastLon == null));

    if (coordinatesMayBePlaceholder && firstNodeId) {
      const lastPosition = await this.prisma.nodePosition.findFirst({
        where: { nodeId: firstNodeId },
        orderBy: { ts: 'desc' },
      });
      if (lastPosition) {
        lat = this.toFinite(lastPosition.lat);
        lon = this.toFinite(lastPosition.lon);
      }
    }

    if (lat === undefined || lon === undefined) {
      throw new BadRequestException(
        'Unable to promote device without a coordinate fix. Wait for the node to report GPS coordinates.',
      );
    }

    const existing = await this.prisma.target.findFirst({
      where: { mac: { equals: normalizedMac } },
    });

    const name = options.name ?? device.vendor ?? normalizedMac;
    const resolvedSiteId = options.siteId ?? device.siteId ?? existing?.siteId ?? undefined;
    const notes = options.notes;
    const tags = options.tags;
    const deviceType = device.type ?? existing?.deviceType ?? undefined;
    firstNodeId = firstNodeId ?? existing?.firstNodeId ?? undefined;

    try {
      await this.prisma.inventoryDevice.update({
        where: { mac: normalizedMac },
        data: {
          lastLat: lat,
          lastLon: lon,
          lastNodeId: firstNodeId ?? null,
          siteId: resolvedSiteId ?? device.siteId ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Unable to persist inventory location for ${normalizedMac}: ${String(error)}`,
      );
    }

    if (existing) {
      const updateData: Prisma.TargetUncheckedUpdateInput = {
        lat,
        lon,
        deviceType: deviceType ?? null,
        firstNodeId: firstNodeId ?? null,
      };

      if (name && name !== existing.name) {
        updateData.name = name;
      }

      if (resolvedSiteId) {
        updateData.siteId = resolvedSiteId;
      }

      if (notes !== undefined) {
        updateData.notes = notes ?? null;
      }

      if (tags !== undefined) {
        updateData.tags = { set: tags ?? [] };
      }

      return this.prisma.target.update({
        where: { id: existing.id },
        data: updateData,
      });
    }

    const createData: Prisma.TargetUncheckedCreateInput = {
      name,
      mac: normalizedMac,
      lat,
      lon,
      deviceType: deviceType ?? null,
      firstNodeId: firstNodeId ?? null,
      siteId: resolvedSiteId ?? null,
      notes: notes ?? null,
    };

    createData.tags = { set: tags ?? [] };

    return this.prisma.target.create({
      data: createData,
    });
  }

  private toFinite(value: number | null | undefined): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    return undefined;
  }

  async clearAll(): Promise<{ deleted: number }> {
    const result = await this.prisma.inventoryDevice.deleteMany();
    return { deleted: result.count };
  }
}
