import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlarmLevel, Geofence, Prisma, Site } from '@prisma/client';
import { Observable, Subject } from 'rxjs';

import { PrismaService } from '../prisma/prisma.service';
import { CreateGeofenceDto } from './dto/create-geofence.dto';
import { ListGeofencesDto } from './dto/list-geofences.dto';
import { UpdateGeofenceDto } from './dto/update-geofence.dto';

export interface GeofenceVertex {
  lat: number;
  lon: number;
}

export interface GeofenceAlarmConfig {
  enabled: boolean;
  level: AlarmLevel;
  message: string;
  triggerOnExit?: boolean;
}

export interface GeofenceResponse {
  id: string;
  siteId?: string | null;
  originSiteId?: string | null;
  name: string;
  description?: string | null;
  color: string;
  polygon: GeofenceVertex[];
  alarm: GeofenceAlarmConfig;
  appliesToAdsb: boolean;
  appliesToDrones: boolean;
  appliesToTargets: boolean;
  appliesToDevices: boolean;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  site?: {
    id: string;
    name?: string | null;
    color?: string | null;
    country?: string | null;
    city?: string | null;
  } | null;
}

export type GeofenceEvent =
  | { type: 'upsert'; geofence: GeofenceResponse }
  | { type: 'delete'; geofence: GeofenceResponse }
  | { type: 'delete-request'; geofence: GeofenceResponse };

export interface GeofenceUpsertPayload {
  id: string;
  siteId?: string | null;
  originSiteId?: string | null;
  name: string;
  description?: string | null;
  color?: string | null;
  polygon: GeofenceVertex[];
  alarmEnabled: boolean;
  alarmLevel: AlarmLevel;
  alarmMessage: string;
  alarmTriggerOnExit?: boolean;
  appliesToAdsb?: boolean;
  appliesToDrones?: boolean;
  appliesToTargets?: boolean;
  appliesToDevices?: boolean;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  site?: {
    id: string;
    name?: string | null;
    color?: string | null;
    country?: string | null;
    city?: string | null;
  };
}

@Injectable()
export class GeofencesService {
  private readonly logger = new Logger(GeofencesService.name);
  private readonly localSiteId: string;
  private readonly changes$ = new Subject<GeofenceEvent>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.localSiteId = this.configService.get<string>('site.id', 'default');
  }

  getChangesStream(): Observable<GeofenceEvent> {
    return this.changes$.asObservable();
  }

  async list(dto: ListGeofencesDto): Promise<GeofenceResponse[]> {
    const includeRemote = dto.includeRemote ?? true;

    const where: Prisma.GeofenceWhereInput = {};
    if (dto.siteId) {
      where.siteId = dto.siteId;
    }
    if (!includeRemote) {
      where.originSiteId = this.localSiteId;
    }

    const geofences = await this.prisma.geofence.findMany({
      where,
      orderBy: [{ siteId: 'asc' }, { updatedAt: 'desc' }],
      include: { site: true },
    });
    return geofences.map((geofence) => this.mapEntity(geofence));
  }

  async getById(id: string): Promise<GeofenceResponse> {
    const geofence = await this.prisma.geofence.findUnique({
      where: { id },
      include: { site: true },
    });
    if (!geofence) {
      throw new NotFoundException(`Geofence ${id} not found`);
    }
    return this.mapEntity(geofence);
  }

  async create(dto: CreateGeofenceDto, createdBy?: string): Promise<GeofenceResponse> {
    const vertices = this.normalizePolygon(dto.polygon);
    if (vertices.length < 3) {
      throw new BadRequestException('polygon must contain at least 3 vertices');
    }

    const siteId =
      dto.siteId && dto.siteId.trim().length > 0 ? dto.siteId.trim() : this.localSiteId;
    await this.ensureSiteRecord(siteId);

    const alarmConfig = dto.alarm;
    const color = dto.color ?? this.pickDefaultColor();

    const createData: Prisma.GeofenceUncheckedCreateInput = {
      siteId,
      originSiteId: this.localSiteId,
      name: dto.name,
      description: dto.description ?? null,
      color,
      polygon: this.serializePolygon(vertices),
      alarmEnabled: alarmConfig.enabled,
      alarmLevel: alarmConfig.level as AlarmLevel,
      alarmMessage: alarmConfig.message,
      alarmTriggerOnExit: alarmConfig.triggerOnExit ?? false,
      appliesToAdsb: dto.appliesToAdsb ?? true,
      appliesToDrones: dto.appliesToDrones ?? true,
      appliesToTargets: dto.appliesToTargets ?? true,
      appliesToDevices: dto.appliesToDevices ?? true,
      createdBy: createdBy ?? null,
    };

    const geofence = await this.prisma.geofence.create({
      data: createData,
      include: { site: true },
    });

    const mapped = this.mapEntity(geofence);
    this.changes$.next({ type: 'upsert', geofence: mapped });
    return mapped;
  }

  async update(id: string, dto: UpdateGeofenceDto): Promise<GeofenceResponse> {
    const existing = await this.prisma.geofence.findUnique({
      where: { id },
      include: { site: true },
    });
    if (!existing) {
      throw new NotFoundException(`Geofence ${id} not found`);
    }

    const data: Prisma.GeofenceUncheckedUpdateInput = {};

    if (dto.name !== undefined) {
      data.name = dto.name;
    }
    if (dto.description !== undefined) {
      data.description = dto.description ?? null;
    }
    if (dto.color !== undefined) {
      data.color = dto.color;
    }
    if (dto.siteId !== undefined) {
      const siteId =
        dto.siteId && dto.siteId.trim().length > 0 ? dto.siteId.trim() : this.localSiteId;
      data.siteId = siteId;
      await this.ensureSiteRecord(siteId);
    }
    if (dto.polygon !== undefined) {
      const vertices = this.normalizePolygon(dto.polygon);
      if (vertices.length < 3) {
        throw new BadRequestException('polygon must contain at least 3 vertices');
      }
      data.polygon = this.serializePolygon(vertices);
    }
    if (dto.alarm) {
      const alarm = dto.alarm;
      if (alarm.enabled !== undefined) {
        data.alarmEnabled = alarm.enabled;
      }
      if (alarm.level !== undefined) {
        data.alarmLevel = alarm.level as AlarmLevel;
      }
      if (alarm.message !== undefined) {
        data.alarmMessage = alarm.message;
      }
      if (alarm.triggerOnExit !== undefined) {
        data.alarmTriggerOnExit = alarm.triggerOnExit;
      }
    }
    if (dto.appliesToAdsb !== undefined) {
      data.appliesToAdsb = dto.appliesToAdsb;
    }
    if (dto.appliesToDrones !== undefined) {
      data.appliesToDrones = dto.appliesToDrones;
    }
    if (dto.appliesToTargets !== undefined) {
      data.appliesToTargets = dto.appliesToTargets;
    }
    if (dto.appliesToDevices !== undefined) {
      data.appliesToDevices = dto.appliesToDevices;
    }

    const geofence = await this.prisma.geofence.update({
      where: { id },
      data,
      include: { site: true },
    });

    const mapped = this.mapEntity(geofence);
    this.changes$.next({ type: 'upsert', geofence: mapped });
    return mapped;
  }

  async delete(id: string): Promise<GeofenceResponse> {
    const existing = await this.prisma.geofence.findUnique({
      where: { id },
      include: { site: true },
    });
    if (!existing) {
      throw new NotFoundException(`Geofence ${id} not found`);
    }

    const mapped = this.mapEntity(existing);

    await this.prisma.geofence.delete({ where: { id } });

    if (existing.originSiteId && existing.originSiteId !== this.localSiteId) {
      this.changes$.next({ type: 'delete-request', geofence: mapped });
      return mapped;
    }

    this.changes$.next({ type: 'delete', geofence: mapped });
    return mapped;
  }

  async syncRemoteGeofence(payload: GeofenceUpsertPayload): Promise<void> {
    const vertices = this.normalizePolygon(payload.polygon);
    const siteId = payload.siteId ?? payload.originSiteId ?? null;

    if (siteId) {
      await this.ensureSiteRecord(
        siteId,
        payload.site?.name ?? null,
        payload.site?.color ?? null,
        payload.site?.country ?? null,
        payload.site?.city ?? null,
      );
    }

    const createData: Prisma.GeofenceUncheckedCreateInput = {
      id: payload.id,
      siteId,
      originSiteId: payload.originSiteId ?? siteId,
      name: payload.name,
      description: payload.description ?? null,
      color: payload.color ?? this.pickDefaultColor(),
      polygon: this.serializePolygon(vertices),
      alarmEnabled: payload.alarmEnabled,
      alarmLevel: payload.alarmLevel,
      alarmMessage: payload.alarmMessage,
      alarmTriggerOnExit: payload.alarmTriggerOnExit ?? false,
      appliesToAdsb: payload.appliesToAdsb ?? true,
      appliesToDrones: payload.appliesToDrones ?? true,
      appliesToTargets: payload.appliesToTargets ?? true,
      appliesToDevices: payload.appliesToDevices ?? true,
      createdBy: payload.createdBy ?? null,
      createdAt: payload.createdAt ? new Date(payload.createdAt) : undefined,
      updatedAt: payload.updatedAt ? new Date(payload.updatedAt) : undefined,
    };

    const updateData: Prisma.GeofenceUncheckedUpdateInput = {
      siteId,
      originSiteId: payload.originSiteId ?? siteId,
      name: payload.name,
      description: payload.description ?? null,
      color: payload.color ?? this.pickDefaultColor(),
      polygon: this.serializePolygon(vertices),
      alarmEnabled: payload.alarmEnabled,
      alarmLevel: payload.alarmLevel,
      alarmMessage: payload.alarmMessage,
      alarmTriggerOnExit: payload.alarmTriggerOnExit ?? false,
      appliesToAdsb: payload.appliesToAdsb ?? true,
      appliesToDrones: payload.appliesToDrones ?? true,
      appliesToTargets: payload.appliesToTargets ?? true,
      appliesToDevices: payload.appliesToDevices ?? true,
      createdBy: payload.createdBy ?? null,
      updatedAt: payload.updatedAt ? new Date(payload.updatedAt) : new Date(),
    };

    const geofence = await this.prisma.geofence.upsert({
      where: { id: payload.id },
      create: createData,
      update: updateData,
      include: { site: true },
    });

    const mapped = this.mapEntity(geofence);
    this.changes$.next({ type: 'upsert', geofence: mapped });
  }

  async syncRemoteGeofenceDelete(id: string): Promise<void> {
    const existing = await this.prisma.geofence.findUnique({
      where: { id },
      include: { site: true },
    });
    if (!existing) {
      return;
    }
    await this.prisma.geofence.delete({ where: { id } });
    const mapped = this.mapEntity(existing);
    this.changes$.next({ type: 'delete', geofence: mapped });
  }

  async syncRemoteGeofenceSnapshot(
    originSiteId: string,
    geofences: GeofenceUpsertPayload[],
  ): Promise<void> {
    const receivedIds = new Set<string>();

    for (const payload of geofences) {
      const normalized: GeofenceUpsertPayload = {
        ...payload,
        originSiteId: payload.originSiteId ?? originSiteId,
      };
      receivedIds.add(normalized.id);
      await this.syncRemoteGeofence(normalized);
    }

    const staleWhere: Prisma.GeofenceWhereInput =
      receivedIds.size > 0
        ? {
            originSiteId,
            id: { notIn: Array.from(receivedIds) },
          }
        : { originSiteId };

    const stale = await this.prisma.geofence.findMany({
      where: staleWhere,
      include: { site: true },
    });
    if (stale.length === 0) {
      return;
    }

    await this.prisma.geofence.deleteMany({
      where: { id: { in: stale.map((geofence) => geofence.id) } },
    });

    stale.forEach((geofence) => {
      const mapped = this.mapEntity(geofence);
      this.changes$.next({ type: 'delete', geofence: mapped });
    });
  }

  private mapEntity(geofence: Geofence & { site?: Site | null }): GeofenceResponse {
    const polygonValue = Array.isArray(geofence.polygon) ? geofence.polygon : [];
    const polygon: GeofenceVertex[] = polygonValue
      .map((vertex) => this.toVertex(vertex))
      .filter((vertex): vertex is GeofenceVertex => vertex !== null);

    return {
      id: geofence.id,
      siteId: geofence.siteId ?? null,
      originSiteId: geofence.originSiteId ?? null,
      name: geofence.name,
      description: geofence.description ?? null,
      color: geofence.color,
      polygon,
      alarm: {
        enabled: geofence.alarmEnabled,
        level: geofence.alarmLevel,
        message: geofence.alarmMessage,
        triggerOnExit: geofence.alarmTriggerOnExit ?? false,
      },
      appliesToAdsb: geofence.appliesToAdsb,
      appliesToDrones: geofence.appliesToDrones,
      appliesToTargets: geofence.appliesToTargets,
      appliesToDevices: geofence.appliesToDevices,
      createdBy: geofence.createdBy ?? null,
      createdAt: geofence.createdAt.toISOString(),
      updatedAt: geofence.updatedAt.toISOString(),
      site: geofence.site
        ? {
            id: geofence.site.id,
            name: geofence.site.name,
            color: geofence.site.color,
            country: geofence.site.country,
            city: geofence.site.city,
          }
        : null,
    };
  }

  private toVertex(value: unknown): GeofenceVertex | null {
    if (!value || typeof value !== 'object') {
      return null;
    }
    const vertex = value as { lat?: unknown; lon?: unknown };
    const lat = typeof vertex.lat === 'number' ? vertex.lat : Number(vertex.lat);
    const lon = typeof vertex.lon === 'number' ? vertex.lon : Number(vertex.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return null;
    }
    return { lat, lon };
  }

  private normalizePolygon(vertices: { lat: number; lon: number }[]): GeofenceVertex[] {
    return vertices
      .map((vertex) => this.toVertex(vertex))
      .filter((vertex): vertex is GeofenceVertex => vertex !== null);
  }

  private serializePolygon(vertices: GeofenceVertex[]): Prisma.InputJsonValue {
    return vertices.map((vertex) => ({ lat: vertex.lat, lon: vertex.lon }));
  }

  private pickDefaultColor(): string {
    const palette = ['#1d4ed8', '#9333ea', '#f97316', '#22c55e', '#0ea5e9', '#facc15', '#ef4444'];
    return palette[Math.floor(Math.random() * palette.length)];
  }

  private async ensureSiteRecord(
    siteId: string,
    name?: string | null,
    color?: string | null,
    country?: string | null,
    city?: string | null,
  ): Promise<void> {
    try {
      await this.prisma.site.upsert({
        where: { id: siteId },
        create: {
          id: siteId,
          name: name ?? siteId,
          color: color ?? '#2563EB',
          country: country ?? undefined,
          city: city ?? undefined,
        },
        update: {
          name: name ?? undefined,
          color: color ?? undefined,
          country: country ?? undefined,
          city: city ?? undefined,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to ensure site record for ${siteId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
