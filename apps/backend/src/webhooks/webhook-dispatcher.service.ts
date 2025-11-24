import { Injectable, Logger } from '@nestjs/common';
import { AlarmLevel, InventoryDevice, Prisma, Webhook, WebhookEventType } from '@prisma/client';
import { createHmac } from 'node:crypto';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import { Agent, request } from 'undici';

import { PrismaService } from '../prisma/prisma.service';
import {
  SerialAlertEvent,
  SerialCommandAck,
  SerialCommandResult,
  SerialDroneTelemetry,
  SerialNodeTelemetry,
  SerialRawFrame,
  SerialTargetDetected,
} from '../serial/serial.types';

type RuleWebhookLink = Prisma.AlertRuleWebhookGetPayload<{
  include: { webhook: true };
}>;

interface WebhookDispatchContext {
  event: string;
  eventType: WebhookEventType;
  timestamp: Date;
  ruleId?: string;
  ruleName?: string;
  severity?: AlarmLevel;
  message?: string;
  matchedCriteria?: string[];
  mac?: string;
  nodeId?: string | null;
  nodeName?: string | null;
  ssid?: string | null;
  channel?: number | null;
  rssi?: number | null;
  lat?: number | null;
  lon?: number | null;
  siteId?: string | null;
  payload?: Record<string, unknown>;
}

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly subscriberCache = new Map<
    WebhookEventType,
    { expiresAt: number; webhooks: Webhook[] }
  >();
  private readonly subscriberCacheTtlMs = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  async dispatchAlert(links: RuleWebhookLink[], context: WebhookDispatchContext): Promise<void> {
    if (!links?.length) {
      return;
    }
    await Promise.all(
      links.map((link) =>
        this.deliver(link.webhook, {
          ...context,
          ruleId: link.ruleId,
          eventType: WebhookEventType.ALERT_TRIGGERED,
        }),
      ),
    );
  }

  async dispatchExternalAlert(context: WebhookDispatchContext): Promise<void> {
    await this.dispatchToSubscribers(WebhookEventType.ALERT_TRIGGERED, context);
  }

  async dispatchInventoryUpdate(device: InventoryDevice): Promise<void> {
    const payload = {
      mac: device.mac,
      vendor: device.vendor,
      type: device.type,
      ssid: device.ssid,
      hits: device.hits,
      lastSeen: device.lastSeen,
      maxRSSI: device.maxRSSI,
      minRSSI: device.minRSSI,
      avgRSSI: device.avgRSSI,
      locallyAdministered: device.locallyAdministered,
      multicast: device.multicast,
      lastNodeId: device.lastNodeId,
      lastLat: device.lastLat,
      lastLon: device.lastLon,
      siteId: device.siteId,
      channel: device.channel,
      updatedAt: device.updatedAt,
    } as Record<string, unknown>;

    const context: WebhookDispatchContext = {
      event: 'inventory.updated',
      eventType: WebhookEventType.INVENTORY_UPDATED,
      timestamp: new Date(),
      message: `Inventory updated for ${device.mac}`,
      mac: device.mac,
      nodeId: device.lastNodeId ?? null,
      channel: device.channel ?? null,
      rssi: device.avgRSSI ?? null,
      lat: device.lastLat ?? null,
      lon: device.lastLon ?? null,
      siteId: device.siteId ?? null,
      payload,
    };

    await this.dispatchToSubscribers(WebhookEventType.INVENTORY_UPDATED, context);
  }

  async dispatchNodeTelemetry(event: SerialNodeTelemetry, siteId?: string | null): Promise<void> {
    const timestamp = event.timestamp ?? new Date();
    await this.dispatchToSubscribers(WebhookEventType.NODE_TELEMETRY, {
      event: 'node.telemetry',
      eventType: WebhookEventType.NODE_TELEMETRY,
      timestamp,
      nodeId: event.nodeId,
      nodeName: event.nodeId,
      lat: event.lat ?? null,
      lon: event.lon ?? null,
      siteId: siteId ?? null,
      payload: {
        raw: event.raw,
        lastMessage: event.lastMessage ?? null,
        temperatureC: event.temperatureC ?? null,
        temperatureF: event.temperatureF ?? null,
      },
    });
  }

  async dispatchTargetDetection(
    event: SerialTargetDetected,
    options: {
      siteId?: string | null;
      timestamp?: Date;
      tracking?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const timestamp = options.timestamp ?? new Date();
    await this.dispatchToSubscribers(WebhookEventType.TARGET_DETECTED, {
      event: 'event.target',
      eventType: WebhookEventType.TARGET_DETECTED,
      timestamp,
      nodeId: event.nodeId ?? null,
      mac: event.mac,
      rssi: event.rssi ?? null,
      channel: event.channel ?? null,
      lat: event.lat ?? null,
      lon: event.lon ?? null,
      siteId: options.siteId ?? null,
      payload: {
        type: event.type ?? null,
        name: event.name ?? null,
        raw: event.raw,
        tracking: options.tracking ?? null,
      },
    });
  }

  async dispatchNodeAlert(
    event: SerialAlertEvent,
    options: {
      siteId?: string | null;
      lat?: number | null;
      lon?: number | null;
      message?: string | null;
    } = {},
  ): Promise<void> {
    const timestamp = new Date();
    await this.dispatchToSubscribers(WebhookEventType.NODE_ALERT, {
      event: 'node.alert',
      eventType: WebhookEventType.NODE_ALERT,
      timestamp,
      nodeId: event.nodeId ?? null,
      nodeName: event.nodeId ?? null,
      severity: event.level as AlarmLevel,
      message: options.message ?? event.message,
      lat: options.lat ?? null,
      lon: options.lon ?? null,
      siteId: options.siteId ?? null,
      payload: {
        raw: event.raw,
        data: event.data ?? null,
        category: event.category,
      },
    });
  }

  async dispatchDroneTelemetry(
    event: SerialDroneTelemetry,
    options: {
      siteId?: string | null;
      nodeId?: string | null;
      timestamp?: Date;
    } = {},
  ): Promise<void> {
    const timestamp = options.timestamp ?? new Date();
    await this.dispatchToSubscribers(WebhookEventType.DRONE_TELEMETRY, {
      event: 'drone.telemetry',
      eventType: WebhookEventType.DRONE_TELEMETRY,
      timestamp,
      nodeId: options.nodeId ?? event.nodeId ?? null,
      siteId: options.siteId ?? null,
      lat: event.lat ?? null,
      lon: event.lon ?? null,
      message: `Drone ${event.droneId} telemetry`,
      payload: {
        droneId: event.droneId,
        mac: event.mac ?? null,
        altitude: event.altitude ?? null,
        speed: event.speed ?? null,
        operatorLat: event.operatorLat ?? null,
        operatorLon: event.operatorLon ?? null,
        rssi: event.rssi ?? null,
        raw: event.raw,
      },
    });
  }

  async dispatchCommandAck(
    event: SerialCommandAck,
    siteId?: string | null,
    timestamp: Date = new Date(),
  ): Promise<void> {
    await this.dispatchToSubscribers(WebhookEventType.COMMAND_ACK, {
      event: 'command.ack',
      eventType: WebhookEventType.COMMAND_ACK,
      timestamp,
      nodeId: event.nodeId,
      siteId: siteId ?? null,
      message: `Command ${event.ackType} acknowledged with status ${event.status}`,
      payload: {
        ackType: event.ackType,
        status: event.status,
        raw: event.raw,
      },
    });
  }

  async dispatchCommandResult(
    event: SerialCommandResult,
    siteId?: string | null,
    timestamp: Date = new Date(),
  ): Promise<void> {
    await this.dispatchToSubscribers(WebhookEventType.COMMAND_RESULT, {
      event: 'command.result',
      eventType: WebhookEventType.COMMAND_RESULT,
      timestamp,
      nodeId: event.nodeId,
      siteId: siteId ?? null,
      message: `Command ${event.command} completed`,
      payload: {
        command: event.command,
        payload: event.payload,
        raw: event.raw,
      },
    });
  }

  async dispatchRawFrame(event: SerialRawFrame, siteId?: string | null): Promise<void> {
    await this.dispatchToSubscribers(WebhookEventType.SERIAL_RAW, {
      event: 'serial.raw',
      eventType: WebhookEventType.SERIAL_RAW,
      timestamp: new Date(),
      siteId: siteId ?? null,
      message: 'Raw serial line received',
      payload: {
        raw: event.raw,
      },
    });
  }

  async sendTest(webhook: Webhook): Promise<void> {
    await this.deliver(webhook, {
      event: 'webhook.test',
      eventType: WebhookEventType.ALERT_TRIGGERED,
      timestamp: new Date(),
      severity: AlarmLevel.INFO,
      message: 'Test payload from Command Center',
      matchedCriteria: [],
      mac: '00:00:00:00:00:00',
      payload: {},
    });
  }

  private async deliver(webhook: Webhook, context: WebhookDispatchContext): Promise<void> {
    if (!webhook?.enabled) {
      return;
    }
    if (
      webhook.subscribedEvents.length > 0 &&
      !webhook.subscribedEvents.includes(context.eventType)
    ) {
      return;
    }

    const payload = {
      event: context.event,
      eventType: context.eventType,
      rule: context.ruleId
        ? {
            id: context.ruleId,
            name: context.ruleName ?? null,
            severity: context.severity ?? null,
          }
        : null,
      data: {
        message: context.message ?? null,
        matchedCriteria: context.matchedCriteria ?? [],
        mac: context.mac ?? null,
        nodeId: context.nodeId ?? null,
        nodeName: context.nodeName ?? null,
        ssid: context.ssid ?? null,
        channel: context.channel ?? null,
        rssi: context.rssi ?? null,
        lat: context.lat ?? null,
        lon: context.lon ?? null,
        siteId: context.siteId ?? null,
        timestamp: context.timestamp.toISOString(),
      },
      payload: context.payload ?? {},
    };

    const serialized = JSON.stringify(payload);
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        ruleId: context.ruleId ?? null,
        requestPayload: payload as Prisma.InputJsonValue,
      },
    });

    const dispatcher = this.buildTlsDispatcher(webhook);

    try {
      const headers = this.buildHeaders(webhook, serialized, context.event);
      const response = await request(webhook.url, {
        method: 'POST',
        headers,
        body: serialized,
        bodyTimeout: 10_000,
        headersTimeout: 10_000,
        dispatcher: dispatcher ?? undefined,
      });
      const responseBody = await response.body.text();
      const success = response.statusCode >= 200 && response.statusCode < 300;
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: response.statusCode,
          success,
          responseBody: responseBody.slice(0, 2000),
          completedAt: new Date(),
        },
      });
      await this.prisma.webhook.update({
        where: { id: webhook.id },
        data: success ? { lastSuccessAt: new Date() } : { lastFailureAt: new Date() },
      });
      if (!success) {
        this.logger.warn(`Webhook ${webhook.id} responded with status ${response.statusCode}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          success: false,
          errorMessage: message.slice(0, 2000),
          completedAt: new Date(),
        },
      });
      await this.prisma.webhook.update({
        where: { id: webhook.id },
        data: { lastFailureAt: new Date() },
      });
      this.logger.error(`Webhook ${webhook.id} delivery failed: ${message}`);
    } finally {
      if (dispatcher) {
        try {
          await dispatcher.close();
        } catch (error) {
          this.logger.debug(
            `Failed to close webhook dispatcher for ${webhook.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  private buildHeaders(webhook: Webhook, body: string, event: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-webhook-id': webhook.id,
      'x-webhook-event': event,
    };
    if (webhook.secret?.length) {
      headers['x-webhook-signature'] = createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');
    }
    return headers;
  }

  private buildTlsDispatcher(webhook: Webhook): Agent | null {
    if (!webhook.url.toLowerCase().startsWith('https://')) {
      return null;
    }

    let connectOptions: TlsConnectionOptions | null = null;
    const ensureConnect = () => {
      if (!connectOptions) {
        connectOptions = {};
      }
      return connectOptions;
    };

    let hasCustomizations = false;

    if (webhook.verifyTls === false) {
      ensureConnect().rejectUnauthorized = false;
      hasCustomizations = true;
    }

    const ca = webhook.caBundle?.trim();
    if (ca) {
      ensureConnect().ca = ca;
      hasCustomizations = true;
    }

    const cert = webhook.clientCert?.trim();
    const key = webhook.clientKey?.trim();
    if (cert && key) {
      const connect = ensureConnect();
      connect.cert = cert;
      connect.key = key;
      hasCustomizations = true;
    }

    if (!hasCustomizations || !connectOptions) {
      return null;
    }

    const options: ConstructorParameters<typeof Agent>[0] = {
      keepAliveTimeout: 0,
      keepAliveMaxTimeout: 0,
      connect: connectOptions as NonNullable<ConstructorParameters<typeof Agent>[0]>['connect'],
    };

    return new Agent(options);
  }

  invalidateSubscriberCache(eventType?: WebhookEventType): void {
    if (eventType) {
      this.subscriberCache.delete(eventType);
      return;
    }
    this.subscriberCache.clear();
  }

  private async dispatchToSubscribers(
    eventType: WebhookEventType,
    context: WebhookDispatchContext,
  ): Promise<void> {
    const subscribers = await this.getSubscribers(eventType);
    if (subscribers.length === 0) {
      return;
    }
    const enriched: WebhookDispatchContext = { ...context, eventType };
    await Promise.all(subscribers.map((webhook) => this.deliver(webhook, enriched)));
  }

  private async getSubscribers(eventType: WebhookEventType): Promise<Webhook[]> {
    const cached = this.subscriberCache.get(eventType);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.webhooks;
    }
    const webhooks = await this.prisma.webhook.findMany({
      where: {
        enabled: true,
        subscribedEvents: { has: eventType },
      },
    });
    this.subscriberCache.set(eventType, { webhooks, expiresAt: now + this.subscriberCacheTtlMs });
    return webhooks;
  }
}
