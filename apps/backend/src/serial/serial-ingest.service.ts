
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';

import { CommandsService } from '../commands/commands.service';
import { InventoryService } from '../inventory/inventory.service';
import { NodesService } from '../nodes/nodes.service';
import { TargetTrackingService } from '../tracking/target-tracking.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';
import { SerialService } from './serial.service';
import { SerialParseResult, SerialTargetDetected } from './serial.types';

@Injectable()
export class SerialIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SerialIngestService.name);
  private subscription?: Subscription;

  constructor(
    private readonly serialService: SerialService,
    private readonly nodesService: NodesService,
    private readonly inventoryService: InventoryService,
    private readonly commandsService: CommandsService,
    private readonly trackingService: TargetTrackingService,
    private readonly gateway: CommandCenterGateway,
  ) {}

  onModuleInit(): void {
    this.subscription = this.serialService.getParsedStream().subscribe((event) => {
      this.handleEvent(event).catch((error) => {
        this.logger.error(`Serial ingest failure: ${error instanceof Error ? error.message : error}`, error);
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  private async handleEvent(event: SerialParseResult): Promise<void> {
    const siteId = this.serialService.getSiteId();

    switch (event.kind) {
      case 'node-telemetry':
        await this.nodesService.upsert({
          id: event.nodeId,
          name: event.nodeId,
          lat: event.lat,
          lon: event.lon,
          lastMessage: event.lastMessage,
          ts: event.timestamp ?? new Date(),
          lastSeen: event.timestamp ?? new Date(),
          siteId,
        });
        this.gateway.emitEvent({
          type: 'node.telemetry',
          nodeId: event.nodeId,
          lat: event.lat,
          lon: event.lon,
          raw: event.raw,
          siteId,
        });
        break;
      case 'target-detected':
        {
          const nodeSnapshot = event.nodeId ? this.nodesService.getSnapshotById(event.nodeId) : undefined;
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

          const latForRecord =
            estimate?.lat ?? event.lat ?? nodeSnapshot?.lat ?? undefined;
          const lonForRecord =
            estimate?.lon ?? event.lon ?? nodeSnapshot?.lon ?? undefined;

          const detectionForPersistence: SerialTargetDetected = {
            ...event,
            lat: latForRecord,
            lon: lonForRecord,
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

          this.gateway.emitEvent({
            type: 'event.target',
            timestamp: detectionTime.toISOString(),
            nodeId: event.nodeId,
            mac: event.mac,
            rssi: event.rssi,
            deviceType: event.type,
            lat: latForRecord ?? nodeSnapshot?.lat ?? null,
            lon: lonForRecord ?? nodeSnapshot?.lon ?? null,
            confidence: trackingPayload?.confidence,
            tracking: trackingPayload,
            message: `Device ${event.mac} discovered (RSSI ${event.rssi ?? 'n/a'})`,
            raw: event.raw,
            siteId,
          });
        }
        break;
      case 'alert':
        {
          const timestamp = new Date();
          const lat =
            typeof event.data?.lat === 'number' ? event.data.lat : undefined;
          const lon =
            typeof event.data?.lon === 'number' ? event.data.lon : undefined;
          this.gateway.emitEvent({
            type: 'event.alert',
            timestamp: timestamp.toISOString(),
            level: event.level,
            category: event.category,
            nodeId: event.nodeId,
            message: event.message,
            lat,
            lon,
            data: event.data,
            raw: event.raw,
            siteId,
          });
          if (event.nodeId && event.message) {
            await this.nodesService.updateLastMessage(event.nodeId, event.message, timestamp);
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
        break;
      case 'raw':
      default:
        this.gateway.emitEvent({ type: 'raw', raw: event.raw });
        break;
    }
  }
}
