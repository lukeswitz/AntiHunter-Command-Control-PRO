import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ExportQueryDto } from './dto/export-query.dto';

export interface ExportResult {
  filename: string;
  contentType: string;
  data: Buffer | string;
}

type NormalizedFormat = 'csv' | 'json' | 'geojson';

interface ExportFilters {
  format: NormalizedFormat;
  from?: Date;
  to?: Date;
  siteId?: string;
}

@Injectable()
export class ExportsService {
  constructor(private readonly prisma: PrismaService) {}

  async generateExport(
    rawType: string,
    query: ExportQueryDto,
    userId?: string | null,
  ): Promise<ExportResult> {
    const type = rawType.toLowerCase();
    const filters = this.normalizeFilters(type, query);

    switch (type) {
      case 'inventory': {
        const result = await this.exportInventory(filters);
        await this.recordAudit(userId, type, filters);
        return result;
      }
      case 'command-logs': {
        const result = await this.exportCommandLogs(filters);
        await this.recordAudit(userId, type, filters);
        return result;
      }
      case 'targets': {
        const result = await this.exportTargets(filters);
        await this.recordAudit(userId, type, filters);
        return result;
      }
      case 'trails': {
        const result = await this.exportTrails(filters);
        await this.recordAudit(userId, type, filters);
        return result;
      }
      default:
        throw new NotFoundException(`Export type "${rawType}" is not supported.`);
    }
  }

  private normalizeFilters(type: string, query: ExportQueryDto): ExportFilters {
    const allowedFormatsByType: Record<string, NormalizedFormat[]> = {
      inventory: ['csv', 'json'],
      'command-logs': ['csv', 'json'],
      targets: ['geojson', 'json', 'csv'],
      trails: ['geojson', 'json'],
    };

    const allowedFormats = allowedFormatsByType[type];
    if (!allowedFormats) {
      throw new NotFoundException(`Export type "${type}" is not supported.`);
    }

    const format = (query.format as NormalizedFormat | undefined) ?? allowedFormats[0];
    if (!allowedFormats.includes(format)) {
      throw new BadRequestException(
        `Format "${query.format}" is not available for ${type} exports.`,
      );
    }

    const from = this.parseDate(query.from, 'from');
    const to = this.parseDate(query.to, 'to');
    if (from && to && from > to) {
      throw new BadRequestException('`from` must be earlier than `to`.');
    }

    return {
      format,
      from,
      to,
      siteId: query.siteId?.trim() || undefined,
    };
  }

  private parseDate(value: string | undefined, field: string): Date | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Invalid ${field} date value.`);
    }
    return parsed;
  }

  private async exportInventory(filters: ExportFilters): Promise<ExportResult> {
    const where: Prisma.InventoryDeviceWhereInput = {};
    if (filters.siteId) {
      where.siteId = filters.siteId;
    }

    const devices = await this.prisma.inventoryDevice.findMany({
      where,
      orderBy: [{ lastSeen: 'desc' }, { mac: 'asc' }],
    });

    const rows = devices.map((device) => ({
      mac: device.mac,
      vendor: device.vendor ?? '',
      type: device.type ?? '',
      ssid: device.ssid ?? '',
      hits: device.hits,
      lastSeen: device.lastSeen ? device.lastSeen.toISOString() : '',
      maxRSSI: device.maxRSSI ?? '',
      minRSSI: device.minRSSI ?? '',
      avgRSSI: device.avgRSSI ?? '',
      locallyAdministered: device.locallyAdministered ? 'true' : 'false',
      multicast: device.multicast ? 'true' : 'false',
      siteId: device.siteId ?? '',
      lastNodeId: device.lastNodeId ?? '',
      lastLat: device.lastLat ?? '',
      lastLon: device.lastLon ?? '',
    }));

    if (filters.format === 'json') {
      return this.jsonResult('inventory', rows);
    }

    const csv = this.buildCsv(
      [
        'mac',
        'vendor',
        'type',
        'ssid',
        'hits',
        'lastSeen',
        'maxRSSI',
        'minRSSI',
        'avgRSSI',
        'locallyAdministered',
        'multicast',
        'siteId',
        'lastNodeId',
        'lastLat',
        'lastLon',
      ],
      rows,
    );
    return this.csvResult('inventory', csv);
  }

  private async exportCommandLogs(filters: ExportFilters): Promise<ExportResult> {
    const where: Prisma.CommandLogWhereInput = {};
    if (filters.from || filters.to) {
      where.startedAt = {};
      if (filters.from) {
        where.startedAt.gte = filters.from;
      }
      if (filters.to) {
        where.startedAt.lte = filters.to;
      }
    }

    const logs = await this.prisma.commandLog.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }],
    });

    const rows = logs.map((log) => ({
      id: log.id,
      target: log.target ?? '',
      name: log.name ?? '',
      status: log.status,
      startedAt: log.startedAt?.toISOString() ?? '',
      finishedAt: log.finishedAt?.toISOString() ?? '',
      ackKind: log.ackKind ?? '',
      ackStatus: log.ackStatus ?? '',
      ackNode: log.ackNode ?? '',
      resultText: log.resultText ?? '',
      errorText: log.errorText ?? '',
      userId: log.userId ?? '',
      params: log.params ? JSON.stringify(log.params) : '',
    }));

    if (filters.format === 'json') {
      return this.jsonResult('command-logs', rows);
    }

    const csv = this.buildCsv(
      [
        'id',
        'target',
        'name',
        'status',
        'startedAt',
        'finishedAt',
        'ackKind',
        'ackStatus',
        'ackNode',
        'resultText',
        'errorText',
        'userId',
        'params',
      ],
      rows,
    );
    return this.csvResult('command-logs', csv);
  }

  private async exportTargets(filters: ExportFilters): Promise<ExportResult> {
    const where: Prisma.TargetWhereInput = {};
    if (filters.siteId) {
      where.siteId = filters.siteId;
    }
    if (filters.from || filters.to) {
      where.updatedAt = {};
      if (filters.from) {
        where.updatedAt.gte = filters.from;
      }
      if (filters.to) {
        where.updatedAt.lte = filters.to;
      }
    }

    const targets = await this.prisma.target.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
    });

    if (filters.format === 'json') {
      return this.jsonResult('targets', targets);
    }

    if (filters.format === 'csv') {
      const rows = targets.map((target) => ({
        id: target.id,
        name: target.name ?? '',
        status: target.status,
        lat: target.lat,
        lon: target.lon,
        url: target.url ?? '',
        notes: target.notes ?? '',
        tags: target.tags?.join('|') ?? '',
        createdBy: target.createdBy ?? '',
        siteId: target.siteId ?? '',
        createdAt: target.createdAt.toISOString(),
        updatedAt: target.updatedAt.toISOString(),
      }));
      const csv = this.buildCsv(
        [
          'id',
          'name',
          'status',
          'lat',
          'lon',
          'url',
          'notes',
          'tags',
          'createdBy',
          'siteId',
          'createdAt',
          'updatedAt',
        ],
        rows,
      );
      return this.csvResult('targets', csv);
    }

    const features = targets
      .filter((target) => typeof target.lat === 'number' && typeof target.lon === 'number')
      .map((target) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [target.lon, target.lat],
        },
        properties: {
          id: target.id,
          name: target.name ?? null,
          status: target.status,
          url: target.url ?? null,
          notes: target.notes ?? null,
          tags: target.tags ?? [],
          siteId: target.siteId ?? null,
          createdBy: target.createdBy ?? null,
          createdAt: target.createdAt.toISOString(),
          updatedAt: target.updatedAt.toISOString(),
        },
      }));

    const geojson = JSON.stringify(
      {
        type: 'FeatureCollection',
        features,
      },
      null,
      2,
    );
    return this.geoJsonResult('targets', geojson);
  }

  private async exportTrails(filters: ExportFilters): Promise<ExportResult> {
    const where: Prisma.NodePositionWhereInput = {};
    if (filters.siteId) {
      where.node = { siteId: filters.siteId };
    }
    if (filters.from || filters.to) {
      where.ts = {};
      if (filters.from) {
        where.ts.gte = filters.from;
      }
      if (filters.to) {
        where.ts.lte = filters.to;
      }
    }

    const positions = await this.prisma.nodePosition.findMany({
      where,
      include: {
        node: true,
      },
      orderBy: [{ nodeId: 'asc' }, { ts: 'asc' }],
    });

    if (filters.format === 'json') {
      const payload = positions.map((position) => ({
        id: position.id,
        nodeId: position.nodeId,
        siteId: position.node?.siteId ?? null,
        lat: position.lat,
        lon: position.lon,
        ts: position.ts.toISOString(),
      }));
      return this.jsonResult('trails', payload);
    }

    const grouped = new Map<
      string,
      { siteId: string | null; coords: [number, number, string][] }
    >();
    positions.forEach((position) => {
      const entry =
        grouped.get(position.nodeId) ??
        grouped
          .set(position.nodeId, {
            siteId: position.node?.siteId ?? null,
            coords: [],
          })
          .get(position.nodeId)!;
      entry.coords.push([position.lon, position.lat, position.ts.toISOString()]);
    });

    const features = Array.from(grouped.entries())
      .filter(([, value]) => value.coords.length >= 2)
      .map(([nodeId, value]) => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: value.coords.map(([lon, lat]) => [lon, lat]),
        },
        properties: {
          nodeId,
          siteId: value.siteId,
          points: value.coords.length,
          firstSeen: value.coords[0][2],
          lastSeen: value.coords[value.coords.length - 1][2],
        },
      }));

    const geojson = JSON.stringify(
      {
        type: 'FeatureCollection',
        features,
      },
      null,
      2,
    );

    return this.geoJsonResult('trails', geojson);
  }

  private csvResult(type: string, csv: string): ExportResult {
    return {
      filename: this.buildFilename(type, 'csv'),
      contentType: 'text/csv; charset=utf-8',
      data: csv,
    };
  }

  private jsonResult(type: string, payload: unknown): ExportResult {
    const body = JSON.stringify(payload, null, 2);
    return {
      filename: this.buildFilename(type, 'json'),
      contentType: 'application/json; charset=utf-8',
      data: body,
    };
  }

  private geoJsonResult(type: string, payload: string): ExportResult {
    return {
      filename: this.buildFilename(type, 'geojson'),
      contentType: 'application/geo+json; charset=utf-8',
      data: payload,
    };
  }

  private buildFilename(type: string, extension: string) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${type}-${timestamp}.${extension}`;
  }

  private buildCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
    const headerLine = headers.join(',');
    if (rows.length === 0) {
      return `${headerLine}\r\n`;
    }

    const lines = rows.map((row) =>
      headers.map((header) => this.escapeCsvValue(row[header])).join(','),
    );
    return [headerLine, ...lines].join('\r\n');
  }

  private escapeCsvValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    const stringValue =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);

    if (/[",\r\n]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }

  private async recordAudit(
    userId: string | null | undefined,
    type: string,
    filters: ExportFilters,
  ) {
    const data: Record<string, unknown> = {
      format: filters.format,
      siteId: filters.siteId ?? null,
      from: filters.from ? filters.from.toISOString() : null,
      to: filters.to ? filters.to.toISOString() : null,
    };

    await this.prisma.auditLog.create({
      data: {
        userId: userId ?? null,
        action: 'EXPORT',
        entity: 'Export',
        entityId: type,
        before: Prisma.JsonNull,
        after: data as Prisma.InputJsonValue,
      },
    });
  }
}
