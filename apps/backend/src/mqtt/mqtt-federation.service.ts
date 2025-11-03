import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';

import { MqttService, SiteMqttContext } from './mqtt.service';
import { NodesService } from '../nodes/nodes.service';
import { NodeSnapshot } from '../nodes/nodes.types';
import { PrismaService } from '../prisma/prisma.service';

type NodeUpsertMessage = {
  type: 'node.upsert';
  originSiteId: string;
  payload: {
    id: string;
    name?: string | null;
    lat: number;
    lon: number;
    ts: string;
    lastMessage?: string | null;
    lastSeen?: string | null;
    siteId?: string | null;
    siteName?: string | null;
    siteColor?: string | null;
    siteCountry?: string | null;
    siteCity?: string | null;
  };
};

const NODE_TOPIC_PATTERN = 'ahcc/+/nodes/upsert';

@Injectable()
export class MqttFederationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttFederationService.name);
  private readonly localSiteId: string;
  private nodeDiffSubscription?: Subscription;
  private readonly inboundHandlers = new Map<string, (topic: string, payload: Buffer) => void>();

  constructor(
    private readonly configService: ConfigService,
    private readonly mqttService: MqttService,
    private readonly nodesService: NodesService,
    private readonly prisma: PrismaService,
  ) {
    this.localSiteId = this.configService.get<string>('site.id', 'default');
  }

  onModuleInit(): void {
    this.nodeDiffSubscription = this.nodesService.getDiffStream().subscribe({
      next: (diff) => {
        if (diff.type === 'upsert') {
          void this.handleLocalNodeUpsert(diff.node);
        }
      },
      error: (error) => {
        this.logger.error(
          `Node diff stream error: ${error instanceof Error ? error.message : error}`,
        );
      },
    });

    this.mqttService.onClientConnected((context) => {
      void this.attachSubscriptions(context).catch((error) => {
        this.logger.error(
          `Failed to attach MQTT federation subscriptions for site ${context.siteId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.nodeDiffSubscription?.unsubscribe();
    this.inboundHandlers.forEach((handler, siteId) => {
      const context = this.mqttService.getConnectedContexts().find((ctx) => ctx.siteId === siteId);
      if (context) {
        context.client.removeListener('message', handler);
      }
    });
    this.inboundHandlers.clear();
  }

  private async handleLocalNodeUpsert(node: NodeSnapshot): Promise<void> {
    const originSiteId = node.originSiteId ?? this.localSiteId;
    if (originSiteId !== this.localSiteId) {
      return;
    }

    const message: NodeUpsertMessage = {
      type: 'node.upsert',
      originSiteId: this.localSiteId,
      payload: {
        id: node.id,
        name: node.name ?? null,
        lat: Number.isFinite(node.lat) ? node.lat : 0,
        lon: Number.isFinite(node.lon) ? node.lon : 0,
        ts: (node.ts ?? new Date()).toISOString(),
        lastMessage: node.lastMessage ?? null,
        lastSeen: node.lastSeen ? node.lastSeen.toISOString() : null,
        siteId: node.siteId ?? this.localSiteId,
        siteName: node.siteName ?? null,
        siteColor: node.siteColor ?? null,
        siteCountry: node.siteCountry ?? null,
        siteCity: node.siteCity ?? null,
      },
    };

    const topic = this.buildNodeUpsertTopic(this.localSiteId);
    try {
      await this.mqttService.publishToAll(topic, JSON.stringify(message), { qos: 1 });
    } catch (error) {
      this.logger.warn(
        `Failed to publish node update for ${node.id}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async attachSubscriptions(context: SiteMqttContext): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      context.client.subscribe(NODE_TOPIC_PATTERN, { qos: 1 }, (err) => {
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
      void this.handleInboundMessage(topic, payload).catch((error) => {
        this.logger.error(
          `Failed to handle inbound MQTT message on ${topic}: ${error instanceof Error ? error.message : error}`,
        );
      });
    };

    this.inboundHandlers.set(context.siteId, handler);
    context.client.on('message', handler);
  }

  private async handleInboundMessage(topic: string, payload: Buffer): Promise<void> {
    if (!topic.startsWith('ahcc/')) {
      return;
    }
    const [_, topicSiteId, resource, action] = topic.split('/');
    if (resource !== 'nodes' || action !== 'upsert') {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid MQTT payload on ${topic}: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    const message = parsed as Partial<NodeUpsertMessage>;
    if (!message || message.type !== 'node.upsert' || !message.payload) {
      return;
    }

    const originSiteId = message.originSiteId ?? topicSiteId;
    if (!originSiteId || originSiteId === this.localSiteId) {
      return;
    }

    const { payload: nodePayload } = message;
    const latValue = Number(nodePayload.lat);
    const lonValue = Number(nodePayload.lon);
    const lat = Number.isFinite(latValue) ? latValue : 0;
    const lon = Number.isFinite(lonValue) ? lonValue : 0;

    const nodeTs = nodePayload.ts ? new Date(nodePayload.ts) : new Date();
    const nodeLastSeen = nodePayload.lastSeen ? new Date(nodePayload.lastSeen) : undefined;
    const targetSiteId = nodePayload.siteId ?? originSiteId;

    await this.ensureSiteRecord(
      targetSiteId,
      nodePayload.siteName,
      nodePayload.siteColor,
      nodePayload.siteCountry,
      nodePayload.siteCity,
    );

    await this.nodesService.upsert({
      id: nodePayload.id,
      name: nodePayload.name ?? undefined,
      lat,
      lon,
      ts: nodeTs,
      lastMessage: nodePayload.lastMessage ?? undefined,
      lastSeen: nodeLastSeen,
      siteId: targetSiteId,
      siteName: nodePayload.siteName ?? undefined,
      siteColor: nodePayload.siteColor ?? undefined,
      siteCountry: nodePayload.siteCountry ?? undefined,
      siteCity: nodePayload.siteCity ?? undefined,
      originSiteId,
    });
  }

  private async ensureSiteRecord(
    siteId: string,
    name?: string | null,
    color?: string | null,
    country?: string | null,
    city?: string | null,
  ) {
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
          color: color ?? '#9333EA',
          country: country ?? undefined,
          city: city ?? undefined,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to ensure site record for ${siteId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private buildNodeUpsertTopic(siteId: string): string {
    return `ahcc/${siteId}/nodes/upsert`;
  }
}
