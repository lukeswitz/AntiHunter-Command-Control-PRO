import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlarmLevel, Drone, Site } from '@prisma/client';
import { DroneStatus } from '@prisma/client';
import { BehaviorSubject, Observable, Subject } from 'rxjs';

import { DroneDiff, DroneSnapshot } from './drones.types';
import { FaaRegistryService } from '../faa/faa.service';
import type { FaaAircraftSummary } from '../faa/faa.types';
import { GeofenceCrossing, GeofenceCrossingService } from '../geofences/geofence-crossing.service';
import { PrismaService } from '../prisma/prisma.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

@Injectable()
export class DronesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DronesService.name);
  private readonly localSiteId: string;
  private readonly drones = new Map<string, DroneSnapshot>();
  private readonly snapshot$ = new BehaviorSubject<DroneSnapshot[]>([]);
  private readonly diff$ = new Subject<DroneDiff>();
  private readonly faaLookupCache = new Map<
    string,
    { summary: FaaAircraftSummary | null; lastAttempt: number }
  >();
  private readonly faaLookupCooldownMs: number;
  private readonly faaEnrichmentQueue = new Set<string>();
  private faaEnrichmentTimer?: NodeJS.Timeout;
  private faaEnrichmentProcessing = false;
  private readonly persistQueue = new Map<string, DroneSnapshot>();
  private persistTimer?: NodeJS.Timeout;
  private persistProcessing = false;
  private persistProcessingPromise?: Promise<void>;
  private readonly persistDebounceMs = 200;
  private skipPersistence = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly faaRegistry: FaaRegistryService,
    @Inject(forwardRef(() => CommandCenterGateway))
    private readonly gateway: CommandCenterGateway,
    private readonly geofenceCrossing: GeofenceCrossingService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
    const cooldownMinutes = configService.get<number>('faa.onlineLookupCooldownMinutes', 10) ?? 10;
    this.faaLookupCooldownMs = Math.max(1, cooldownMinutes) * 60 * 1000;
  }

  async onModuleInit(): Promise<void> {
    const records = await this.prisma.drone.findMany({
      include: {
        site: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });

    for (const record of records) {
      const snapshot = this.mapEntity(record);
      this.drones.set(snapshot.id, snapshot);
      this.scheduleFaaEnrichment(snapshot);
    }

    this.emitSnapshot();
  }

  async onModuleDestroy(): Promise<void> {
    this.snapshot$.complete();
    this.diff$.complete();
    if (this.faaEnrichmentTimer) {
      clearTimeout(this.faaEnrichmentTimer);
      this.faaEnrichmentTimer = undefined;
    }
    this.faaEnrichmentQueue.clear();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (this.persistQueue.size > 0) {
      await this.processPersistQueue();
    }
  }

  getSnapshot(): DroneSnapshot[] {
    return Array.from(this.drones.values());
  }

  getSnapshotById(id: string): DroneSnapshot | undefined {
    return this.drones.get(id);
  }

  getSnapshotStream(): Observable<DroneSnapshot[]> {
    return this.snapshot$.asObservable();
  }

  getDiffStream(): Observable<DroneDiff> {
    return this.diff$.asObservable();
  }

  async upsert(snapshot: DroneSnapshot): Promise<DroneSnapshot> {
    const normalized = this.normalizeSnapshot(snapshot);
    const merged = this.mergeSnapshot(this.drones.get(normalized.id), normalized);
    this.drones.set(merged.id, merged);
    this.emitSnapshot();
    this.diff$.next({ type: 'upsert', drone: merged });
    this.geofenceCrossing
      .evaluate('drone', merged.id, merged.droneId ?? merged.id, merged.lat, merged.lon)
      .forEach((crossing) => this.emitGeofenceCrossing(merged, crossing));
    this.scheduleFaaEnrichment(merged);
    this.enqueuePersist(merged);
    return merged;
  }

  async updateStatus(id: string, status: DroneStatus): Promise<DroneSnapshot> {
    const existing = this.drones.get(id) ?? (await this.loadAndCacheDrone(id));
    if (!existing) {
      throw new NotFoundException(`Drone ${id} not found`);
    }
    const updated: DroneSnapshot = {
      ...existing,
      status,
      ts: new Date(),
    };
    this.drones.set(updated.id, updated);
    this.emitSnapshot();
    this.diff$.next({ type: 'upsert', drone: updated });
    this.scheduleFaaEnrichment(updated);
    this.enqueuePersist(updated);
    return updated;
  }

  async remove(id: string): Promise<void> {
    this.persistQueue.delete(id);
    const existing = this.drones.get(id);
    if (!existing) {
      return;
    }
    await this.prisma.drone.delete({ where: { id } }).catch((error) => {
      this.logger.warn(
        `Failed to delete drone ${id}: ${error instanceof Error ? error.message : error}`,
      );
    });
    this.drones.delete(id);
    this.geofenceCrossing.forget(existing.id);
    this.emitSnapshot();
    this.diff$.next({ type: 'delete', drone: existing });
    this.emitRemovalEvent(existing);
  }

  async clearAll(): Promise<void> {
    if (this.drones.size === 0) {
      await this.prisma.drone.deleteMany().catch(() => undefined);
      return;
    }

    this.skipPersistence = true;
    try {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = undefined;
      }
      this.persistQueue.clear();
      await this.waitForPersistIdle();

      const existing = Array.from(this.drones.values());
      await this.prisma.drone.deleteMany();
      this.drones.clear();
      this.faaLookupCache.clear();
      this.faaEnrichmentQueue.clear();
      if (this.faaEnrichmentTimer) {
        clearTimeout(this.faaEnrichmentTimer);
        this.faaEnrichmentTimer = undefined;
      }
      this.emitSnapshot();
      existing.forEach((drone) => {
        this.diff$.next({ type: 'delete', drone });
        this.emitRemovalEvent(drone);
      });
    } finally {
      this.skipPersistence = false;
    }
  }

  private emitSnapshot(): void {
    this.snapshot$.next(
      Array.from(this.drones.values()).sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime()),
    );
  }

  private normalizeSnapshot(snapshot: DroneSnapshot): DroneSnapshot {
    const now = new Date();
    const lastSeen = snapshot.lastSeen ?? now;
    const ts = snapshot.ts ?? lastSeen ?? now;
    return {
      id: snapshot.id,
      droneId: snapshot.droneId ?? null,
      mac: snapshot.mac ?? null,
      nodeId: snapshot.nodeId ?? null,
      siteId: snapshot.siteId ?? this.localSiteId,
      originSiteId: snapshot.originSiteId ?? snapshot.siteId ?? this.localSiteId,
      siteName: snapshot.siteName ?? null,
      siteColor: snapshot.siteColor ?? null,
      siteCountry: snapshot.siteCountry ?? null,
      siteCity: snapshot.siteCity ?? null,
      lat: snapshot.lat,
      lon: snapshot.lon,
      altitude: snapshot.altitude ?? null,
      speed: snapshot.speed ?? null,
      operatorLat: snapshot.operatorLat ?? null,
      operatorLon: snapshot.operatorLon ?? null,
      rssi: snapshot.rssi != null ? Math.round(snapshot.rssi) : null,
      status: snapshot.status ?? DroneStatus.UNKNOWN,
      lastSeen,
      ts,
      faa: snapshot.faa ?? null,
    };
  }

  private mergeSnapshot(
    existing: DroneSnapshot | undefined,
    incoming: DroneSnapshot,
  ): DroneSnapshot {
    return {
      id: incoming.id,
      droneId: incoming.droneId ?? existing?.droneId ?? null,
      mac: incoming.mac ?? existing?.mac ?? null,
      nodeId: incoming.nodeId ?? existing?.nodeId ?? null,
      siteId: incoming.siteId ?? existing?.siteId ?? null,
      originSiteId: incoming.originSiteId ?? existing?.originSiteId ?? incoming.siteId ?? null,
      siteName: incoming.siteName ?? existing?.siteName ?? null,
      siteColor: incoming.siteColor ?? existing?.siteColor ?? null,
      siteCountry: incoming.siteCountry ?? existing?.siteCountry ?? null,
      siteCity: incoming.siteCity ?? existing?.siteCity ?? null,
      lat: incoming.lat ?? existing?.lat ?? 0,
      lon: incoming.lon ?? existing?.lon ?? 0,
      altitude: incoming.altitude ?? existing?.altitude ?? null,
      speed: incoming.speed ?? existing?.speed ?? null,
      operatorLat: incoming.operatorLat ?? existing?.operatorLat ?? null,
      operatorLon: incoming.operatorLon ?? existing?.operatorLon ?? null,
      rssi: incoming.rssi ?? existing?.rssi ?? null,
      status: incoming.status ?? existing?.status ?? DroneStatus.UNKNOWN,
      lastSeen: incoming.lastSeen ?? existing?.lastSeen ?? new Date(),
      ts: incoming.ts ?? existing?.ts ?? incoming.lastSeen ?? new Date(),
      faa: incoming.faa ?? existing?.faa ?? null,
    };
  }

  private mapEntity(drone: Drone & { site?: Site | null }): DroneSnapshot {
    const existing = this.drones.get(drone.id);
    return {
      id: drone.id,
      droneId: drone.droneId ?? null,
      mac: drone.mac ?? null,
      nodeId: drone.nodeId ?? null,
      siteId: drone.siteId ?? null,
      originSiteId: drone.originSiteId ?? null,
      siteName: drone.site?.name ?? null,
      siteColor: drone.site?.color ?? null,
      siteCountry: drone.site?.country ?? null,
      siteCity: drone.site?.city ?? null,
      lat: drone.lat,
      lon: drone.lon,
      altitude: drone.altitude ?? null,
      speed: drone.speed ?? null,
      operatorLat: drone.operatorLat ?? null,
      operatorLon: drone.operatorLon ?? null,
      rssi: drone.rssi ?? null,
      status: drone.status ?? DroneStatus.UNKNOWN,
      lastSeen: drone.lastSeen,
      ts: drone.updatedAt,
      faa: existing?.faa ?? null,
    };
  }

  private scheduleFaaEnrichment(snapshot: DroneSnapshot): void {
    if (snapshot.faa || (!snapshot.droneId && !snapshot.mac)) {
      return;
    }
    if (this.faaEnrichmentQueue.has(snapshot.id)) {
      return;
    }
    this.faaEnrichmentQueue.add(snapshot.id);
    if (!this.faaEnrichmentTimer) {
      this.faaEnrichmentTimer = setTimeout(() => {
        this.faaEnrichmentTimer = undefined;
        void this.processFaaEnrichmentQueue();
      }, 50);
    }
  }

  private async processFaaEnrichmentQueue(): Promise<void> {
    if (this.faaEnrichmentProcessing) {
      return;
    }
    this.faaEnrichmentProcessing = true;
    try {
      while (this.faaEnrichmentQueue.size > 0) {
        const iterator = this.faaEnrichmentQueue.values().next();
        if (iterator.done) {
          break;
        }
        const id = iterator.value;
        this.faaEnrichmentQueue.delete(id);
        const snapshot = this.drones.get(id);
        if (!snapshot || snapshot.faa || (!snapshot.droneId && !snapshot.mac)) {
          continue;
        }
        const summary = await this.lookupFaaMetadata(snapshot);
        if (!summary) {
          continue;
        }
        const updated: DroneSnapshot = { ...snapshot, faa: summary };
        this.drones.set(id, updated);
        this.emitSnapshot();
        this.diff$.next({ type: 'upsert', drone: updated });
        this.emitTelemetryUpdate(updated);
        this.enqueuePersist(updated);
      }
    } catch (error) {
      this.logger.debug(
        `FAA enrichment processing error: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.faaEnrichmentProcessing = false;
    }
  }

  private async lookupFaaMetadata(snapshot: DroneSnapshot): Promise<FaaAircraftSummary | null> {
    if (!snapshot.droneId && !snapshot.mac) {
      return null;
    }
    const cacheKey = (snapshot.droneId ?? snapshot.mac ?? snapshot.id).toUpperCase();
    const cached = this.faaLookupCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.lastAttempt < this.faaLookupCooldownMs) {
      return cached.summary;
    }
    try {
      const summary = await this.faaRegistry.lookupAircraft(snapshot.droneId, snapshot.mac);
      const resolved = summary ?? null;
      this.faaLookupCache.set(cacheKey, { summary: resolved, lastAttempt: now });
      return resolved;
    } catch (error) {
      this.logger.debug(
        `FAA lookup failed for drone ${snapshot.id}: ${error instanceof Error ? error.message : error}`,
      );
      this.faaLookupCache.set(cacheKey, { summary: null, lastAttempt: now });
      return null;
    }
  }

  private enqueuePersist(snapshot: DroneSnapshot): void {
    if (this.skipPersistence) {
      return;
    }
    this.persistQueue.set(snapshot.id, snapshot);
    if (this.persistProcessing) {
      return;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.processPersistQueue();
    }, this.persistDebounceMs);
  }

  private async processPersistQueue(): Promise<void> {
    if (this.persistProcessing) {
      return this.persistProcessingPromise ?? Promise.resolve();
    }
    this.persistProcessing = true;
    this.persistProcessingPromise = (async () => {
      try {
        while (this.persistQueue.size > 0) {
          const batch = Array.from(this.persistQueue.values());
          this.persistQueue.clear();
          for (const snapshot of batch) {
            await this.persistSnapshot(snapshot);
          }
        }
      } finally {
        this.persistProcessing = false;
        this.persistProcessingPromise = undefined;
      }
    })();
    return this.persistProcessingPromise;
  }

  private async waitForPersistIdle(): Promise<void> {
    if (!this.persistProcessingPromise) {
      return;
    }
    try {
      await this.persistProcessingPromise;
    } catch (error) {
      this.logger.debug(
        `Persist queue wait failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async persistSnapshot(snapshot: DroneSnapshot): Promise<void> {
    if (this.skipPersistence) {
      return;
    }
    try {
      await this.ensureSiteRecord(
        snapshot.siteId,
        snapshot.siteName ?? null,
        snapshot.siteColor ?? null,
        snapshot.siteCountry ?? null,
        snapshot.siteCity ?? null,
      );

      await this.prisma.drone.upsert({
        where: { id: snapshot.id },
        create: {
          id: snapshot.id,
          droneId: snapshot.droneId ?? null,
          mac: snapshot.mac ?? null,
          nodeId: snapshot.nodeId ?? null,
          siteId: snapshot.siteId ?? null,
          originSiteId: snapshot.originSiteId ?? snapshot.siteId ?? null,
          lat: snapshot.lat,
          lon: snapshot.lon,
          altitude: snapshot.altitude ?? null,
          speed: snapshot.speed ?? null,
          operatorLat: snapshot.operatorLat ?? null,
          operatorLon: snapshot.operatorLon ?? null,
          rssi: snapshot.rssi ?? null,
          lastSeen: snapshot.lastSeen,
          status: snapshot.status ?? DroneStatus.UNKNOWN,
        },
        update: {
          droneId: snapshot.droneId ?? null,
          mac: snapshot.mac ?? null,
          nodeId: snapshot.nodeId ?? null,
          siteId: snapshot.siteId ?? null,
          originSiteId: snapshot.originSiteId ?? undefined,
          lat: snapshot.lat,
          lon: snapshot.lon,
          altitude: snapshot.altitude ?? null,
          speed: snapshot.speed ?? null,
          operatorLat: snapshot.operatorLat ?? null,
          operatorLon: snapshot.operatorLon ?? null,
          rssi: snapshot.rssi ?? null,
          lastSeen: snapshot.lastSeen,
          status: snapshot.status ?? undefined,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist drone ${snapshot.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private emitTelemetryUpdate(snapshot: DroneSnapshot): void {
    try {
      this.gateway.emitEvent({
        type: 'drone.telemetry',
        droneId: snapshot.droneId ?? snapshot.id,
        mac: snapshot.mac ?? null,
        nodeId: snapshot.nodeId ?? null,
        lat: snapshot.lat,
        lon: snapshot.lon,
        altitude: snapshot.altitude ?? null,
        speed: snapshot.speed ?? null,
        operatorLat: snapshot.operatorLat ?? null,
        operatorLon: snapshot.operatorLon ?? null,
        rssi: snapshot.rssi ?? null,
        siteId: snapshot.siteId ?? null,
        siteName: snapshot.siteName ?? null,
        siteColor: snapshot.siteColor ?? null,
        siteCountry: snapshot.siteCountry ?? null,
        siteCity: snapshot.siteCity ?? null,
        originSiteId: snapshot.originSiteId ?? null,
        timestamp: snapshot.lastSeen.toISOString(),
        status: snapshot.status,
        faa: snapshot.faa ?? null,
      });
    } catch (error) {
      this.logger.debug(
        `Failed to emit telemetry update for ${snapshot.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async loadAndCacheDrone(id: string): Promise<DroneSnapshot | undefined> {
    try {
      const record = await this.prisma.drone.findUnique({
        where: { id },
        include: { site: true },
      });
      if (!record) {
        return undefined;
      }
      const mapped = this.mapEntity(record);
      this.drones.set(mapped.id, mapped);
      return mapped;
    } catch (error) {
      this.logger.warn(
        `Failed to load drone ${id}: ${error instanceof Error ? error.message : error}`,
      );
      return undefined;
    }
  }

  private async ensureSiteRecord(
    siteId?: string | null,
    name?: string | null,
    color?: string | null,
    country?: string | null,
    city?: string | null,
  ): Promise<void> {
    if (!siteId) {
      return;
    }

    try {
      await this.prisma.site.upsert({
        where: { id: siteId },
        update: {
          name: name ?? undefined,
          color: color ?? undefined,
          country: country ?? undefined,
          city: city ?? undefined,
        },
        create: {
          id: siteId,
          name: name ?? siteId,
          color: color ?? '#0ea5e9',
          country: country ?? undefined,
          city: city ?? undefined,
        },
      });
    } catch (error) {
      this.logger.debug(
        `Failed to ensure site record for ${siteId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private emitGeofenceCrossing(drone: DroneSnapshot, crossing: GeofenceCrossing): void {
    const label = drone.droneId ?? drone.id;
    try {
      this.gateway.emitEvent({
        type: 'event.alert',
        category: 'geofence',
        level: (crossing.geofence.alarm.level as AlarmLevel) ?? 'NOTICE',
        geofenceId: crossing.geofence.id,
        geofenceName: crossing.geofence.name,
        nodeId: label,
        siteId: drone.siteId ?? crossing.geofence.siteId ?? this.localSiteId,
        message: crossing.message,
        lat: drone.lat,
        lon: drone.lon,
        timestamp: new Date().toISOString(),
        data: {
          geofenceId: crossing.geofence.id,
          geofenceName: crossing.geofence.name,
          entity: label,
          kind: 'drone',
          event: crossing.transition,
        },
      });
    } catch (error) {
      this.logger.debug(
        `Failed to emit drone geofence crossing for ${drone.id}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  private emitRemovalEvent(drone: DroneSnapshot): void {
    try {
      this.gateway.emitEvent({
        type: 'drone.remove',
        droneId: drone.droneId ?? drone.id,
        id: drone.id,
        siteId: drone.siteId ?? undefined,
        nodeId: drone.nodeId ?? undefined,
      });
    } catch (error) {
      this.logger.debug(
        `Failed to emit drone removal event for ${drone.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
