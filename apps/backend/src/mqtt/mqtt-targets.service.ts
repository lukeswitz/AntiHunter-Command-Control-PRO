import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Target } from '@prisma/client';
import { Subscription } from 'rxjs';

import { MqttService, SiteMqttContext } from './mqtt.service';
import { TargetsService, TargetEvent, TargetUpsertPayload } from '../targets/targets.service';

type TargetUpsertMessage = {
  type: 'target.upsert';
  originSiteId: string;
  payload: TargetUpsertPayload;
};

type TargetDeleteMessage = {
  type: 'target.delete';
  originSiteId: string;
  targetId: string;
};

const TARGET_UPSERT_TOPIC_PATTERN = 'ahcc/+/targets/upsert';
const TARGET_DELETE_TOPIC_PATTERN = 'ahcc/+/targets/delete';

@Injectable()
export class MqttTargetsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttTargetsService.name);
  private readonly localSiteId: string;
  private readonly enabled: boolean;
  private changesSubscription?: Subscription;
  private readonly inboundHandlers = new Map<string, (topic: string, payload: Buffer) => void>();

  constructor(
    configService: ConfigService,
    private readonly targetsService: TargetsService,
    private readonly mqttService: MqttService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
    this.enabled = configService.get<boolean>('mqtt.enabled', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('MQTT target federation disabled via configuration');
      return;
    }

    this.changesSubscription = this.targetsService.getChangesStream().subscribe((event) => {
      void this.handleLocalTargetEvent(event).catch((error) => {
        this.logger.error(
          `Failed to publish target event ${event.target.id}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    });

    this.mqttService.onClientConnected((context) => {
      void this.attachSubscriptions(context).catch((error) => {
        this.logger.error(
          `Failed to attach target subscriptions for site ${context.siteId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.changesSubscription?.unsubscribe();
    this.inboundHandlers.forEach((handler, siteId) => {
      const context = this.mqttService.getConnectedContexts().find((ctx) => ctx.siteId === siteId);
      context?.client.removeListener('message', handler);
    });
    this.inboundHandlers.clear();
  }

  private async attachSubscriptions(context: SiteMqttContext): Promise<void> {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        context.client.subscribe(TARGET_UPSERT_TOPIC_PATTERN, { qos: context.qosEvents }, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
      new Promise<void>((resolve, reject) => {
        context.client.subscribe(TARGET_DELETE_TOPIC_PATTERN, { qos: context.qosEvents }, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
    ]);

    const existing = this.inboundHandlers.get(context.siteId);
    if (existing) {
      context.client.removeListener('message', existing);
    }

    const handler = (topic: string, payload: Buffer) => {
      if (topic.endsWith('/targets/upsert')) {
        void this.handleInboundTargetUpsert(topic, payload).catch((error) => {
          this.logger.error(
            `Failed processing inbound target upsert (${topic}): ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
        return;
      }
      if (topic.endsWith('/targets/delete')) {
        void this.handleInboundTargetDelete(topic, payload).catch((error) => {
          this.logger.error(
            `Failed processing inbound target delete (${topic}): ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
      }
    };

    this.inboundHandlers.set(context.siteId, handler);
    context.client.on('message', handler);
  }

  private async handleLocalTargetEvent(event: TargetEvent): Promise<void> {
    const targetSiteId = event.target.siteId ?? this.localSiteId;
    if (targetSiteId !== this.localSiteId) {
      return;
    }

    if (event.type === 'upsert') {
      const topic = this.buildUpsertTopic(targetSiteId);
      const message: TargetUpsertMessage = {
        type: 'target.upsert',
        originSiteId: targetSiteId,
        payload: this.mapTargetToPayload(event.target),
      };
      await this.mqttService.publishToAll(topic, JSON.stringify(message));
    } else if (event.type === 'delete') {
      const topic = this.buildDeleteTopic(targetSiteId);
      const message: TargetDeleteMessage = {
        type: 'target.delete',
        originSiteId: targetSiteId,
        targetId: event.target.id,
      };
      await this.mqttService.publishToAll(topic, JSON.stringify(message));
    }
  }

  private async handleInboundTargetUpsert(topic: string, payload: Buffer): Promise<void> {
    const [, topicSiteId] = topic.split('/');

    let parsed: TargetUpsertMessage;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as TargetUpsertMessage;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid target payload on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    if (parsed.type !== 'target.upsert') {
      return;
    }

    const originSiteId = parsed.originSiteId ?? topicSiteId ?? this.localSiteId;
    if (originSiteId === this.localSiteId) {
      return;
    }

    await this.targetsService.syncRemoteTarget(parsed.payload);
  }

  private async handleInboundTargetDelete(topic: string, payload: Buffer): Promise<void> {
    const [, topicSiteId] = topic.split('/');

    let parsed: TargetDeleteMessage;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as TargetDeleteMessage;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid target delete payload on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    if (parsed.type !== 'target.delete') {
      return;
    }

    const originSiteId = parsed.originSiteId ?? topicSiteId ?? this.localSiteId;
    if (originSiteId === this.localSiteId) {
      return;
    }

    await this.targetsService.syncRemoteTargetDelete(parsed.targetId);
  }

  private buildUpsertTopic(siteId: string): string {
    return `ahcc/${siteId}/targets/upsert`;
  }

  private buildDeleteTopic(siteId: string): string {
    return `ahcc/${siteId}/targets/delete`;
  }

  private mapTargetToPayload(target: Target): TargetUpsertPayload {
    return {
      id: target.id,
      name: target.name ?? null,
      mac: target.mac ?? null,
      lat: target.lat,
      lon: target.lon,
      url: target.url ?? null,
      notes: target.notes ?? null,
      tags: target.tags ?? [],
      siteId: target.siteId ?? null,
      createdBy: target.createdBy ?? null,
      deviceType: target.deviceType ?? null,
      firstNodeId: target.firstNodeId ?? null,
      status: target.status,
      createdAt: target.createdAt ? target.createdAt.toISOString() : null,
      updatedAt: target.updatedAt ? target.updatedAt.toISOString() : null,
    };
  }
}
