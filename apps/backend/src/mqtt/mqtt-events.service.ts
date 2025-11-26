import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlarmLevel, DroneStatus } from '@prisma/client';
import { Subscription } from 'rxjs';

import { MqttService, SiteMqttContext } from './mqtt.service';
import { DronesService } from '../drones/drones.service';
import { EventBusService, CommandCenterEvent } from '../events/event-bus.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

type EventBroadcastMessage = {
  type: 'event.broadcast';
  originSiteId: string;
  eventType: string;
  payload: CommandCenterEvent;
};

type DroneTelemetryEvent = CommandCenterEvent & {
  type: 'drone.telemetry';
  droneId?: string;
  mac?: string | null;
  nodeId?: string | null;
  siteName?: string | null;
  siteColor?: string | null;
  siteCountry?: string | null;
  siteCity?: string | null;
  lat?: number;
  lon?: number;
  altitude?: number | string | null;
  speed?: number | string | null;
  operatorLat?: number | string | null;
  operatorLon?: number | string | null;
  rssi?: number | string | null;
  timestamp?: string | Date;
  status?: string;
};

type DroneStatusEvent = CommandCenterEvent & {
  type: 'drone.status';
  droneId?: string;
  status?: string;
};

type AlertEvent = CommandCenterEvent & {
  type: 'event.alert';
  id?: string;
  nodeId?: string;
  message?: string;
  level?: AlarmLevel;
  timestamp?: string | Date;
  data?: Record<string, unknown>;
};

const EVENT_TOPIC_PATTERN = 'ahcc/+/events/+';
const FEDERATED_EVENT_TYPES = new Set([
  'event.alert',
  'event.target',
  'command.ack',
  'command.result',
  'drone.telemetry',
  'drone.status',
]);

@Injectable()
export class MqttEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttEventsService.name);
  private readonly localSiteId: string;
  private readonly enabled: boolean;
  private readonly processRemoteAlerts: boolean;
  private subscription?: Subscription;
  private readonly inboundHandlers = new Map<string, (topic: string, payload: Buffer) => void>();
  private readonly seenAlertIds = new Map<string, number>();
  private static readonly ALERT_DEDUPE_MS = 5 * 60 * 1000;

  constructor(
    configService: ConfigService,
    private readonly eventBus: EventBusService,
    private readonly mqttService: MqttService,
    private readonly gateway: CommandCenterGateway,
    private readonly dronesService: DronesService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
    this.enabled = configService.get<boolean>('mqtt.enabled', true);
    this.processRemoteAlerts = configService.get<boolean>('mqtt.processRemoteAlerts', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('MQTT event federation disabled via configuration');
      return;
    }

    this.subscription = this.eventBus.getStream().subscribe((event) => {
      void this.handleLocalEvent(event).catch((error) => {
        this.logger.error(
          `Failed to publish event ${event.type}: ${error instanceof Error ? error.message : error}`,
        );
      });
    });

    this.mqttService.onClientConnected((context) => {
      void this.attachSubscription(context).catch((error) => {
        this.logger.error(
          `Failed to attach event subscriptions for site ${context.siteId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.inboundHandlers.forEach((handler, siteId) => {
      const context = this.mqttService.getConnectedContexts().find((ctx) => ctx.siteId === siteId);
      context?.client.removeListener('message', handler);
    });
    this.inboundHandlers.clear();
  }

  private async attachSubscription(context: SiteMqttContext): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      context.client.subscribe(EVENT_TOPIC_PATTERN, { qos: context.qosEvents }, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    const existing = this.inboundHandlers.get(context.siteId);
    if (existing) {
      context.client.removeListener('message', existing);
    }

    const handler = (topic: string, payload: Buffer) => {
      if (!topic.includes('/events/')) {
        return;
      }
      void this.handleInboundEvent(payload, topic).catch((error) => {
        this.logger.error(
          `Failed processing inbound event (${topic}): ${error instanceof Error ? error.message : error}`,
        );
      });
    };

    this.inboundHandlers.set(context.siteId, handler);
    context.client.on('message', handler);
  }

  private async handleLocalEvent(event: CommandCenterEvent): Promise<void> {
    if (!FEDERATED_EVENT_TYPES.has(event.type)) {
      return;
    }

    const siteId =
      typeof event.siteId === 'string' && event.siteId.length > 0 ? event.siteId : this.localSiteId;
    if (siteId !== this.localSiteId) {
      return;
    }

    const topic = this.buildEventTopic(siteId, event.type);
    const message: EventBroadcastMessage = {
      type: 'event.broadcast',
      originSiteId: siteId,
      eventType: event.type,
      payload: event,
    };

    await this.mqttService.publishToAll(topic, JSON.stringify(message));
  }

  private async handleInboundEvent(payload: Buffer, topic: string): Promise<void> {
    let message: EventBroadcastMessage;
    try {
      message = JSON.parse(payload.toString('utf8')) as EventBroadcastMessage;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid event payload on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    if (message.type !== 'event.broadcast') {
      return;
    }

    const originSiteId = message.originSiteId ?? this.localSiteId;
    if (originSiteId === this.localSiteId) {
      return;
    }

    const event = {
      ...message.payload,
      siteId: message.payload.siteId ?? originSiteId,
      originSiteId,
    };

    if (isDroneTelemetryEvent(event)) {
      const droneId = typeof event.droneId === 'string' ? event.droneId : undefined;
      const lat = typeof event.lat === 'number' ? event.lat : Number(event.lat);
      const lon = typeof event.lon === 'number' ? event.lon : Number(event.lon);
      if (droneId && Number.isFinite(lat) && Number.isFinite(lon)) {
        const existingDrone = this.dronesService.getSnapshotById(droneId);
        const nextStatus =
          (isDroneStatus(event.status) ? event.status : undefined) ??
          existingDrone?.status ??
          DroneStatus.UNKNOWN;

        await this.dronesService.upsert({
          id: droneId,
          droneId,
          mac: typeof event.mac === 'string' ? event.mac : null,
          nodeId: typeof event.nodeId === 'string' ? event.nodeId : null,
          siteId: event.siteId ?? originSiteId,
          siteName: typeof event.siteName === 'string' ? event.siteName : null,
          siteColor: typeof event.siteColor === 'string' ? event.siteColor : null,
          siteCountry: typeof event.siteCountry === 'string' ? event.siteCountry : null,
          siteCity: typeof event.siteCity === 'string' ? event.siteCity : null,
          lat,
          lon,
          altitude:
            typeof event.altitude === 'number'
              ? event.altitude
              : (toNumber(event.altitude as string | number | null | undefined) ?? null),
          speed:
            typeof event.speed === 'number'
              ? event.speed
              : (toNumber(event.speed as string | number | null | undefined) ?? null),
          operatorLat:
            typeof event.operatorLat === 'number'
              ? event.operatorLat
              : (toNumber(event.operatorLat as string | number | null | undefined) ?? null),
          operatorLon:
            typeof event.operatorLon === 'number'
              ? event.operatorLon
              : (toNumber(event.operatorLon as string | number | null | undefined) ?? null),
          rssi:
            typeof event.rssi === 'number'
              ? event.rssi
              : (toNumber(event.rssi as string | number | null | undefined) ?? null),
          lastSeen: event.timestamp ? new Date(event.timestamp as string) : new Date(),
          ts: event.timestamp ? new Date(event.timestamp as string) : new Date(),
          status: nextStatus,
        });
      }
    } else if (isDroneStatusEvent(event)) {
      const droneId = typeof event.droneId === 'string' ? event.droneId : undefined;
      if (!droneId) {
        return;
      }
      const status = isDroneStatus(event.status) ? event.status : undefined;
      if (!status) {
        return;
      }
      try {
        await this.dronesService.updateStatus(droneId, status);
      } catch (error) {
        this.logger.warn(
          `Failed to apply drone status update for ${droneId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    } else if (isAlertEvent(event)) {
      if (!this.processRemoteAlerts) {
        this.gateway.emitEvent(event, { skipBus: true });
        return;
      }

      const alertId =
        typeof event.id === 'string'
          ? event.id
          : `${originSiteId}-${event.nodeId ?? 'unknown'}-${event.timestamp ?? Date.now()}-${
              event.message ?? ''
            }`;

      const now = Date.now();
      this.seenAlertIds.forEach((ts, key) => {
        if (now - ts > MqttEventsService.ALERT_DEDUPE_MS) {
          this.seenAlertIds.delete(key);
        }
      });
      if (this.seenAlertIds.has(alertId)) {
        return;
      }
      this.seenAlertIds.set(alertId, now);

      this.gateway.emitEvent(event, { skipBus: true });

      try {
        await this.webhookDispatcher.dispatchExternalAlert({
          event: 'alert.remote',
          eventType: 'ALERT_TRIGGERED',
          timestamp: event.timestamp ? new Date(event.timestamp as string) : new Date(),
          message: typeof event.message === 'string' ? event.message : undefined,
          severity: typeof event.level === 'string' ? event.level : undefined,
          siteId: originSiteId,
          nodeId: typeof event.nodeId === 'string' ? event.nodeId : null,
          payload: event.data,
        });
      } catch (error) {
        this.logger.warn(
          `Failed to process remote alert ${alertId} from ${originSiteId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
      return;
    }

    this.gateway.emitEvent(event, { skipBus: true });
  }

  private buildEventTopic(siteId: string, eventType: string): string {
    const sanitized = eventType.replace(/\//g, '-').replace(/\s+/g, '-').replace(/\./g, '-');
    return `ahcc/${siteId}/events/${sanitized}`;
  }
}

function isDroneTelemetryEvent(event: CommandCenterEvent): event is DroneTelemetryEvent {
  return event.type === 'drone.telemetry';
}

function isDroneStatusEvent(event: CommandCenterEvent): event is DroneStatusEvent {
  return event.type === 'drone.status';
}

function isAlertEvent(event: CommandCenterEvent): event is AlertEvent {
  return event.type === 'event.alert';
}

function isDroneStatus(value: unknown): value is DroneStatus {
  return (
    value === DroneStatus.UNKNOWN ||
    value === DroneStatus.FRIENDLY ||
    value === DroneStatus.NEUTRAL ||
    value === DroneStatus.HOSTILE
  );
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
