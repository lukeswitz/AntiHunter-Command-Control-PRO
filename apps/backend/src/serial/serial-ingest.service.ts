import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DroneStatus } from '@prisma/client';
import { Subscription } from 'rxjs';

import { SerialService } from './serial.service';
import { SerialAlertEvent, SerialParseResult, SerialTargetDetected } from './serial.types';
import { AlertRulesEngineService } from '../alert-rules/alert-rules-engine.service';
import { CommandsService } from '../commands/commands.service';
import { DronesService } from '../drones/drones.service';
import { InventoryService } from '../inventory/inventory.service';
import { NodesService } from '../nodes/nodes.service';
import { TakService } from '../tak/tak.service';
import { TargetsService } from '../targets/targets.service';
import { TargetTrackingService } from '../tracking/target-tracking.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

const QUEUE_CLEARED_MESSAGE = 'Serial ingest queue cleared';

interface PendingTask<T = unknown> {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

class SerialIngestQueue {
  private readonly pending: PendingTask[] = [];

  private active = 0;

  constructor(private readonly concurrency: number) {}

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run: () => task(),
        resolve: resolve as PendingTask['resolve'],
        reject,
      });
      this.process();
    });
  }

  clear(): void {
    while (this.pending.length > 0) {
      const pending = this.pending.shift();
      pending?.reject(new Error(QUEUE_CLEARED_MESSAGE));
    }
  }

  get size(): number {
    return this.pending.length;
  }

  private process(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) {
        break;
      }
      this.active += 1;
      next
        .run()
        .then((result) => {
          next.resolve(result);
        })
        .catch((error) => {
          next.reject(error);
        })
        .finally(() => {
          this.active -= 1;
          this.process();
        });
    }
  }
}

@Injectable()
export class SerialIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SerialIngestService.name);
  private subscription?: Subscription;
  private static readonly DUPLICATE_WINDOW_MS = 750;
  private static readonly DUPLICATE_CACHE_MAX = 512;
  private readonly duplicateKeys = new Map<string, number>();
  private readonly ingestQueue: SerialIngestQueue;
  private readonly ingestHighWaterMark: number;
  private lastBacklogWarning = 0;
  private readonly recordDroneInventory: boolean;

  constructor(
    private readonly serialService: SerialService,
    private readonly nodesService: NodesService,
    private readonly inventoryService: InventoryService,
    private readonly commandsService: CommandsService,
    private readonly trackingService: TargetTrackingService,
    private readonly gateway: CommandCenterGateway,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly takService: TakService,
    private readonly dronesService: DronesService,
    private readonly alertRulesEngine: AlertRulesEngineService,
    private readonly targetsService: TargetsService,
    configService: ConfigService,
  ) {
    const concurrency = Math.max(1, configService.get<number>('serial.ingestConcurrency', 1));
    this.ingestQueue = new SerialIngestQueue(concurrency);
    this.ingestHighWaterMark = Math.max(
      concurrency * 10,
      configService.get<number>('serial.ingestBuffer', 500),
    );
    this.recordDroneInventory = configService.get<boolean>('drones.recordInventory', false);
  }

  onModuleInit(): void {
    this.subscription = this.serialService.getParsedStream().subscribe((event) => {
      this.enqueueEvent(event);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.ingestQueue.clear();
  }

  private enqueueEvent(event: SerialParseResult): void {
    const backlog = this.ingestQueue.size;
    if (backlog > this.ingestHighWaterMark) {
      const now = Date.now();
      if (now - this.lastBacklogWarning > 5000) {
        this.logger.warn(`Serial ingest backlog at ${backlog} events (processing queued)`);
        this.lastBacklogWarning = now;
      }
    }

    void this.ingestQueue
      .add(async () => {
        await this.handleEvent(event);
      })
      .catch((error) => {
        if (error instanceof Error && error.message === QUEUE_CLEARED_MESSAGE) {
          return;
        }
        this.logger.error(
          `Serial ingest failure: ${error instanceof Error ? error.message : error}`,
          error,
        );
      });
  }

  private async handleEvent(event: SerialParseResult): Promise<void> {
    const siteId = this.serialService.getSiteId();
    if (this.shouldFilterDuplicate(event, siteId)) {
      return;
    }

    switch (event.kind) {
      case 'node-telemetry':
        {
          const temperatureProvided =
            event.temperatureC !== undefined || event.temperatureF !== undefined;
          const temperatureUpdatedAt =
            event.temperatureUpdatedAt ??
            (temperatureProvided ? (event.timestamp ?? new Date()) : undefined);
          await this.nodesService.upsert({
            id: event.nodeId,
            name: event.nodeId,
            lat: event.lat ?? 0,
            lon: event.lon ?? 0,
            lastMessage: event.lastMessage,
            ts: event.timestamp ?? new Date(),
            lastSeen: event.timestamp ?? new Date(),
            siteId,
            temperatureC: event.temperatureC,
            temperatureF: event.temperatureF,
            temperatureUpdatedAt,
          });
          this.gateway.emitEvent({
            type: 'node.telemetry',
            nodeId: event.nodeId,
            lat: event.lat ?? 0,
            lon: event.lon ?? 0,
            raw: event.raw,
            siteId,
            temperatureC: event.temperatureC ?? null,
            temperatureF: event.temperatureF ?? null,
          });
          void this.takService.streamNodeTelemetry({
            nodeId: event.nodeId,
            name: event.nodeId,
            lat: event.lat,
            lon: event.lon,
            message: event.lastMessage,
            siteId,
            timestamp: event.timestamp ?? new Date(),
          });
          void this.webhookDispatcher
            .dispatchNodeTelemetry(event, siteId)
            .catch((error) =>
              this.logger.warn(
                `Failed to dispatch node telemetry webhook: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        }
        break;
      case 'target-detected':
        {
          const nodeSnapshot = event.nodeId
            ? this.nodesService.getSnapshotById(event.nodeId)
            : undefined;
          const detectionTime = new Date();
          const estimate = this.trackingService.ingestDetection({
            mac: event.mac,
            nodeId: event.nodeId,
            nodeLat: nodeSnapshot?.lat,
            nodeLon: nodeSnapshot?.lon,
            targetLat: event.lat,
            targetLon: event.lon,
            rssi: event.rssi,
            siteId,
            timestamp: detectionTime.getTime(),
          });

          const latForRecord = estimate?.lat ?? event.lat ?? nodeSnapshot?.lat ?? undefined;
          const lonForRecord = estimate?.lon ?? event.lon ?? nodeSnapshot?.lon ?? undefined;

          const detectionForPersistence: SerialTargetDetected = {
            ...event,
            lat: latForRecord,
            lon: lonForRecord,
            channel: event.channel,
          };

          await this.inventoryService.recordDetection(
            detectionForPersistence,
            siteId,
            nodeSnapshot?.lat,
            nodeSnapshot?.lon,
          );

          if (estimate?.shouldPersist) {
            await this.trackingService.persistEstimate(estimate.mac, estimate);
          }

          const trackingPayload = estimate
            ? {
                confidence: Number(estimate.confidence.toFixed(3)),
                spreadMeters: Number(estimate.spreadMeters.toFixed(2)),
                contributors: estimate.contributors.slice(0, 5),
                uniqueNodes: estimate.uniqueNodes,
                samples: estimate.samples,
              }
            : undefined;

          await this.alertRulesEngine.evaluateTargetDetection({
            event,
            siteId,
            nodeName: nodeSnapshot?.name ?? event.nodeId ?? undefined,
            nodeLat: nodeSnapshot?.lat,
            nodeLon: nodeSnapshot?.lon,
            lat: latForRecord ?? undefined,
            lon: lonForRecord ?? undefined,
            timestamp: detectionTime,
          });

          this.gateway.emitEvent({
            type: 'event.target',
            timestamp: detectionTime.toISOString(),
            nodeId: event.nodeId,
            mac: event.mac,
            rssi: event.rssi,
            deviceType: event.type,
            lat: latForRecord ?? nodeSnapshot?.lat ?? null,
            lon: lonForRecord ?? nodeSnapshot?.lon ?? null,
            channel: event.channel ?? null,
            confidence: trackingPayload?.confidence,
            tracking: trackingPayload,
            message: `Device ${event.mac} discovered (RSSI ${event.rssi ?? 'n/a'})`,
            raw: event.raw,
            siteId,
          });
          void this.takService.streamTargetDetection({
            mac: event.mac,
            nodeId: event.nodeId,
            lat: latForRecord ?? undefined,
            lon: lonForRecord ?? undefined,
            rssi: event.rssi,
            confidence: trackingPayload?.confidence,
            deviceType: event.type,
            message: `Device ${event.mac} discovered (RSSI ${event.rssi ?? 'n/a'})`,
            siteId,
          });
          void this.webhookDispatcher
            .dispatchTargetDetection(event, {
              siteId,
              timestamp: detectionTime,
              tracking: trackingPayload,
            })
            .catch((error) =>
              this.logger.warn(
                `Failed to dispatch target webhook: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        }
        break;
      case 'alert':
        {
          const timestamp = new Date();
          const { lat, lon } = this.extractCoordinates(event);
          const { temperatureC, temperatureF } = this.extractAlertTemperatures(event);
          const temperatureProvided = temperatureC !== undefined || temperatureF !== undefined;
          const temperatureUpdatedAt = temperatureProvided ? timestamp : undefined;
          const sanitizedMessage = this.sanitizeMessage(event.message);
          this.gateway.emitEvent({
            type: 'event.alert',
            timestamp: timestamp.toISOString(),
            level: event.level,
            category: event.category,
            nodeId: event.nodeId,
            message: sanitizedMessage,
            lat,
            lon,
            data: event.data,
            raw: event.raw,
            siteId,
          });
          const allowNodePositionUpdate = (() => {
            if (!event.category) return false;
            const normalized = event.category.toLowerCase();
            // Triangulation alerts contain target GPS, not node GPS. Avoid
            // overwriting the node snapshot with tracking estimates.
            return normalized === 'gps' || normalized === 'status';
          })();

          if (allowNodePositionUpdate && event.nodeId && lat != null && lon != null) {
            await this.nodesService.upsert({
              id: event.nodeId,
              name: event.nodeId,
              lat,
              lon,
              lastMessage: sanitizedMessage ?? event.message,
              ts: timestamp,
              lastSeen: timestamp,
              siteId,
              ...(temperatureProvided && {
                temperatureC,
                temperatureF,
                temperatureUpdatedAt,
              }),
            });
          }
          if (event.nodeId && (event.message || sanitizedMessage)) {
            await this.nodesService.updateLastMessage(
              event.nodeId,
              sanitizedMessage ?? event.message ?? '',
              timestamp,
              temperatureProvided
                ? {
                    temperatureC,
                    temperatureF,
                    temperatureUpdatedAt,
                  }
                : undefined,
            );
          }
          void this.takService.streamAlert({
            level: event.level,
            nodeId: event.nodeId,
            lat,
            lon,
            message: sanitizedMessage ?? event.message ?? '',
            category: event.category,
            siteId,
            timestamp,
          });
          void this.webhookDispatcher
            .dispatchNodeAlert(event, {
              siteId,
              lat,
              lon,
              message: sanitizedMessage ?? event.message ?? '',
            })
            .catch((error) =>
              this.logger.warn(
                `Failed to dispatch node alert webhook: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );

          const isTriangulationComplete =
            event.category?.toLowerCase() === 'triangulation' &&
            typeof event.data === 'object' &&
            event.data !== null &&
            ((event.data as { stage?: unknown }).stage === 'complete' ||
              (event.data as { stage?: unknown }).stage === 'final');
          const macFromData =
            typeof event.data === 'object' &&
            event.data !== null &&
            'mac' in (event.data as Record<string, unknown>)
              ? (event.data as { mac?: unknown }).mac
              : undefined;
          if (isTriangulationComplete && macFromData && lat != null && lon != null) {
            const macString = String(macFromData);
            void this.targetsService
              .applyTrackingEstimate(macString, lat, lon, siteId)
              .catch((error) =>
                this.logger.warn(
                  `Failed to apply triangulation estimate for ${macString}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                ),
              );
          }
        }
        break;
      case 'command-ack':
        await this.commandsService.handleAck(event);
        this.gateway.emitEvent({
          type: 'command.ack',
          nodeId: event.nodeId,
          ackType: event.ackType,
          status: event.status,
          raw: event.raw,
          siteId,
        });
        void this.takService.streamCommandAck({
          nodeId: event.nodeId,
          ackType: event.ackType,
          status: event.status,
          siteId,
          timestamp: new Date(),
        });
        void this.webhookDispatcher
          .dispatchCommandAck(event, siteId)
          .catch((error) =>
            this.logger.warn(
              `Failed to dispatch command ACK webhook: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        break;
      case 'command-result':
        await this.commandsService.handleResult(event);
        this.gateway.emitEvent({
          type: 'command.result',
          nodeId: event.nodeId,
          command: event.command,
          payload: event.payload,
          raw: event.raw,
          siteId,
        });
        void this.takService.streamCommandResult({
          nodeId: event.nodeId,
          command: event.command,
          siteId,
          result: event.payload,
          timestamp: new Date(),
        });
        void this.webhookDispatcher
          .dispatchCommandResult(event, siteId)
          .catch((error) =>
            this.logger.warn(
              `Failed to dispatch command result webhook: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        break;
      case 'drone-telemetry':
        {
          const timestamp = event.timestamp ?? new Date();
          const nodeSnapshot = event.nodeId
            ? this.nodesService.getSnapshotById(event.nodeId)
            : undefined;
          const resolvedSiteId = nodeSnapshot?.siteId ?? siteId;
          const reportingNodeId = nodeSnapshot?.id ?? null;
          const existingDrone = this.dronesService.getSnapshotById(event.droneId);
          const nextStatus = existingDrone?.status ?? DroneStatus.UNKNOWN;

          const droneSnapshot = await this.dronesService.upsert({
            id: event.droneId,
            droneId: event.droneId,
            mac: event.mac ?? null,
            nodeId: reportingNodeId,
            siteId: resolvedSiteId,
            originSiteId: resolvedSiteId ?? siteId ?? null,
            siteName: nodeSnapshot?.siteName ?? null,
            siteColor: nodeSnapshot?.siteColor ?? null,
            siteCountry: nodeSnapshot?.siteCountry ?? null,
            siteCity: nodeSnapshot?.siteCity ?? null,
            lat: event.lat,
            lon: event.lon,
            altitude: event.altitude ?? null,
            speed: event.speed ?? null,
            operatorLat: event.operatorLat ?? null,
            operatorLon: event.operatorLon ?? null,
            rssi: event.rssi ?? null,
            lastSeen: timestamp,
            ts: timestamp,
            status: nextStatus,
          });

          if (this.recordDroneInventory && event.mac && event.nodeId) {
            await this.inventoryService.recordDetection(
              {
                kind: 'target-detected',
                nodeId: event.nodeId,
                mac: event.mac,
                rssi: event.rssi,
                type: 'Drone',
                lat: event.lat,
                lon: event.lon,
                raw: event.raw,
              },
              resolvedSiteId,
              event.lat,
              event.lon,
            );
          }

          this.gateway.emitEvent({
            type: 'drone.telemetry',
            droneId: event.droneId,
            mac: event.mac ?? null,
            nodeId: reportingNodeId ?? event.nodeId ?? null,
            lat: event.lat,
            lon: event.lon,
            altitude: event.altitude ?? null,
            speed: event.speed ?? null,
            operatorLat: event.operatorLat ?? null,
            operatorLon: event.operatorLon ?? null,
            rssi: event.rssi ?? null,
            siteId: resolvedSiteId,
            siteName: nodeSnapshot?.siteName ?? null,
            siteColor: nodeSnapshot?.siteColor ?? null,
            siteCountry: nodeSnapshot?.siteCountry ?? null,
            siteCity: nodeSnapshot?.siteCity ?? null,
            originSiteId: droneSnapshot.originSiteId ?? resolvedSiteId ?? null,
            timestamp: timestamp.toISOString(),
            status: droneSnapshot.status,
            faa: droneSnapshot.faa ?? null,
          });
          void this.webhookDispatcher
            .dispatchDroneTelemetry(event, {
              siteId: resolvedSiteId,
              nodeId: reportingNodeId ?? event.nodeId ?? null,
              timestamp,
            })
            .catch((error) =>
              this.logger.warn(
                `Failed to dispatch drone telemetry webhook: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        }
        break;
      case 'raw':
      default:
        this.gateway.emitEvent({ type: 'raw', raw: event.raw });
        void this.webhookDispatcher
          .dispatchRawFrame(event, siteId)
          .catch((error) =>
            this.logger.warn(
              `Failed to dispatch raw serial webhook: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        break;
    }
  }

  private shouldFilterDuplicate(event: SerialParseResult, siteId: string | null): boolean {
    if (event.kind === 'node-telemetry') {
      return false;
    }
    const key = this.buildDuplicateKey(event, siteId);
    if (!key) {
      return false;
    }
    const now = Date.now();
    const lastSeen = this.duplicateKeys.get(key);
    if (lastSeen && now - lastSeen < SerialIngestService.DUPLICATE_WINDOW_MS) {
      return true;
    }
    this.duplicateKeys.set(key, now);
    if (this.duplicateKeys.size > SerialIngestService.DUPLICATE_CACHE_MAX) {
      const cutoff = now - SerialIngestService.DUPLICATE_WINDOW_MS;
      for (const [candidate, ts] of this.duplicateKeys.entries()) {
        if (ts < cutoff || this.duplicateKeys.size > SerialIngestService.DUPLICATE_CACHE_MAX) {
          this.duplicateKeys.delete(candidate);
        }
        if (this.duplicateKeys.size <= SerialIngestService.DUPLICATE_CACHE_MAX) {
          break;
        }
      }
    }
    return false;
  }

  private parseNumeric(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private extractCoordinates(event: SerialAlertEvent): { lat?: number; lon?: number } {
    const latValue = typeof event.data?.lat === 'number' ? event.data.lat : undefined;
    const lonValue = typeof event.data?.lon === 'number' ? event.data.lon : undefined;
    if (latValue != null && lonValue != null) {
      return { lat: latValue, lon: lonValue };
    }
    const text = event.message ?? event.raw ?? '';
    const coordinateRegex =
      /GPS(?:[:=\s]+[A-Z]+[\s:]*)?(?:[A-Za-z0-9_-]+\s+)?(?<lat>-?\d+(?:\.\d+)?)(?:\s*(?:deg)?\s*(?<latDir>[NnSs]))?,\s*(?<lon>-?\d+(?:\.\d+)?)(?:\s*(?:deg)?\s*(?<lonDir>[EeWw]))?/;
    const match = coordinateRegex.exec(text);
    if (!match?.groups) {
      return {};
    }
    const latParsed = Number(match.groups.lat);
    const lonParsed = Number(match.groups.lon);
    if (!Number.isFinite(latParsed) || !Number.isFinite(lonParsed)) {
      return {};
    }
    const latDir = match.groups.latDir?.toUpperCase();
    const lonDir = match.groups.lonDir?.toUpperCase();
    const latFinal =
      latDir === 'S' ? -Math.abs(latParsed) : latDir === 'N' ? Math.abs(latParsed) : latParsed;
    const lonFinal =
      lonDir === 'W' ? -Math.abs(lonParsed) : lonDir === 'E' ? Math.abs(lonParsed) : lonParsed;
    return { lat: latFinal, lon: lonFinal };
  }

  private extractAlertTemperatures(event: SerialAlertEvent): {
    temperatureC?: number;
    temperatureF?: number;
  } {
    const temperatureC = this.parseNumeric(event.data?.tempC ?? event.data?.temperatureC);
    const temperatureF = this.parseNumeric(event.data?.tempF ?? event.data?.temperatureF);
    if (temperatureC !== undefined || temperatureF !== undefined) {
      return { temperatureC, temperatureF };
    }
    const text = event.message ?? event.raw ?? '';
    const tempRegex =
      /temp(?:erature)?[:=\s]*(?<c>-?\d+(?:\.\d+)?)\s*(?:°?\s*C)?(?:\s*\/\s*(?<f>-?\d+(?:\.\d+)?)\s*(?:°?\s*F)?)?/i;
    const match = tempRegex.exec(text);
    if (!match?.groups) {
      return {};
    }
    const parsedC = match.groups.c ? Number(match.groups.c) : undefined;
    const parsedF = match.groups.f ? Number(match.groups.f) : undefined;
    return {
      temperatureC: Number.isFinite(parsedC) ? parsedC : undefined,
      temperatureF: Number.isFinite(parsedF) ? parsedF : undefined,
    };
  }

  private buildDuplicateKey(event: SerialParseResult, siteId: string | null): string | null {
    switch (event.kind) {
      case 'alert': {
        const dataTime = this.extractAlertTimestamp(event.data);
        return [
          'alert',
          siteId ?? 'local',
          event.nodeId ?? 'unknown',
          event.category ?? 'generic',
          event.message ?? '',
          dataTime ?? '',
        ].join(':');
      }
      case 'target-detected':
        return [
          'target',
          siteId ?? 'local',
          event.nodeId ?? 'unknown',
          event.mac,
          event.channel ?? 'na',
          event.type ?? '',
        ].join(':');
      case 'command-ack':
        return ['ack', event.nodeId ?? 'unknown', event.ackType, event.status].join(':');
      case 'command-result':
        return ['result', event.nodeId ?? 'unknown', event.command, event.payload].join(':');
      case 'raw':
        return ['raw', event.raw].join(':');
      default:
        return null;
    }
  }

  private extractAlertTimestamp(data?: Record<string, unknown>): string | undefined {
    if (!data) {
      return undefined;
    }
    if (typeof data.time === 'string') {
      return data.time;
    }
    const withTs = data as { ts?: unknown };
    if (typeof withTs.ts === 'string') {
      return withTs.ts;
    }
    return undefined;
  }

  private sanitizeMessage(value?: string | null): string | undefined {
    if (!value) {
      return value ?? undefined;
    }
    return value.replace(/\/?undefinedf\b/gi, '').trim();
  }
}
