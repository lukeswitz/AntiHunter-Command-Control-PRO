import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';

import { MqttService, SiteMqttContext } from './mqtt.service';
import {
  GeofenceEvent,
  GeofenceUpsertPayload,
  GeofencesService,
} from '../geofences/geofences.service';

type GeofenceUpsertMessage = {
  type: 'geofence.upsert';
  originSiteId: string;
  payload: GeofenceUpsertPayload;
};

type GeofenceDeleteMessage = {
  type: 'geofence.delete';
  originSiteId: string;
  geofenceId: string;
};

type GeofenceSnapshotMessage = {
  type: 'geofence.snapshot';
  originSiteId: string;
  generatedAt: string;
  geofences: GeofenceUpsertPayload[];
};

const GEOFENCE_UPSERT_TOPIC_PATTERN = 'ahcc/+/geofences/upsert';
const GEOFENCE_DELETE_TOPIC_PATTERN = 'ahcc/+/geofences/delete';
const GEOFENCE_SNAPSHOT_TOPIC_PATTERN = 'ahcc/+/geofences/snapshot';

@Injectable()
export class MqttGeofencesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttGeofencesService.name);
  private readonly localSiteId: string;
  private readonly enabled: boolean;
  private changesSubscription?: Subscription;
  private readonly inboundHandlers = new Map<string, (topic: string, payload: Buffer) => void>();

  constructor(
    configService: ConfigService,
    private readonly geofencesService: GeofencesService,
    private readonly mqttService: MqttService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
    this.enabled = configService.get<boolean>('mqtt.enabled', true);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('MQTT geofence federation disabled via configuration');
      return;
    }

    this.changesSubscription = this.geofencesService.getChangesStream().subscribe((event) => {
      void this.handleLocalGeofenceEvent(event).catch((error) => {
        this.logger.error(
          `Failed to publish geofence event ${event.geofence.id}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    });

    this.mqttService.onClientConnected((context) => {
      void this.attachSubscriptions(context).catch((error) => {
        this.logger.error(
          `Failed to attach geofence subscriptions for site ${context.siteId}: ${
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
        context.client.subscribe(
          GEOFENCE_UPSERT_TOPIC_PATTERN,
          { qos: context.qosEvents },
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          },
        );
      }),
      new Promise<void>((resolve, reject) => {
        context.client.subscribe(
          GEOFENCE_DELETE_TOPIC_PATTERN,
          { qos: context.qosEvents },
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          },
        );
      }),
      new Promise<void>((resolve, reject) => {
        context.client.subscribe(
          GEOFENCE_SNAPSHOT_TOPIC_PATTERN,
          { qos: context.qosEvents },
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          },
        );
      }),
    ]);

    const existing = this.inboundHandlers.get(context.siteId);
    if (existing) {
      context.client.removeListener('message', existing);
    }

    const handler = (topic: string, payload: Buffer) => {
      if (topic.endsWith('/geofences/upsert')) {
        void this.handleInboundUpsert(topic, payload).catch((error) => {
          this.logger.error(
            `Failed processing inbound geofence upsert (${topic}): ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
        return;
      }

      if (topic.endsWith('/geofences/delete')) {
        void this.handleInboundDelete(topic, payload).catch((error) => {
          this.logger.error(
            `Failed processing inbound geofence delete (${topic}): ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
        return;
      }

      if (topic.endsWith('/geofences/snapshot')) {
        void this.handleInboundSnapshot(topic, payload).catch((error) => {
          this.logger.error(
            `Failed processing inbound geofence snapshot (${topic}): ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
      }
    };

    this.inboundHandlers.set(context.siteId, handler);
    context.client.on('message', handler);

    void this.sendSnapshotToContext(context).catch((error) => {
      this.logger.error(
        `Failed to publish geofence snapshot to ${context.siteId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    });
  }

  private async handleLocalGeofenceEvent(event: GeofenceEvent): Promise<void> {
    const originSiteId = event.geofence.originSiteId ?? this.localSiteId;
    if (originSiteId !== this.localSiteId) {
      return;
    }

    if (event.type === 'upsert') {
      const topic = this.buildUpsertTopic(originSiteId);
      const message: GeofenceUpsertMessage = {
        type: 'geofence.upsert',
        originSiteId,
        payload: this.mapGeofenceToPayload(event.geofence),
      };
      await this.mqttService.publishToAll(topic, JSON.stringify(message));
    } else if (event.type === 'delete') {
      const topic = this.buildDeleteTopic(originSiteId);
      const message: GeofenceDeleteMessage = {
        type: 'geofence.delete',
        originSiteId,
        geofenceId: event.geofence.id,
      };
      await this.mqttService.publishToAll(topic, JSON.stringify(message));
    } else if (event.type === 'delete-request') {
      const targetSiteId = event.geofence.originSiteId;
      if (!targetSiteId || targetSiteId === this.localSiteId) {
        return;
      }
      const topic = this.buildDeleteTopic(targetSiteId);
      const message: GeofenceDeleteMessage = {
        type: 'geofence.delete',
        originSiteId: this.localSiteId,
        geofenceId: event.geofence.id,
      };
      await this.mqttService.publishToAll(topic, JSON.stringify(message));
    }
  }

  private async handleInboundUpsert(topic: string, payload: Buffer): Promise<void> {
    const [, topicSiteId] = topic.split('/');

    let parsed: GeofenceUpsertMessage;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as GeofenceUpsertMessage;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid geofence payload on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    if (parsed.type !== 'geofence.upsert') {
      return;
    }

    const originSiteId = parsed.originSiteId ?? topicSiteId ?? this.localSiteId;
    if (originSiteId === this.localSiteId) {
      return;
    }

    await this.geofencesService.syncRemoteGeofence(parsed.payload);
  }

  private async handleInboundDelete(topic: string, payload: Buffer): Promise<void> {
    const [, topicSiteId] = topic.split('/');

    let parsed: GeofenceDeleteMessage;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as GeofenceDeleteMessage;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid geofence delete payload on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    if (parsed.type !== 'geofence.delete') {
      return;
    }

    const originSiteId = parsed.originSiteId ?? topicSiteId ?? this.localSiteId;
    if (originSiteId === this.localSiteId) {
      return;
    }

    await this.geofencesService.syncRemoteGeofenceDelete(parsed.geofenceId);
  }

  private async handleInboundSnapshot(topic: string, payload: Buffer): Promise<void> {
    const [, topicSiteId] = topic.split('/');

    let parsed: GeofenceSnapshotMessage;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as GeofenceSnapshotMessage;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid geofence snapshot payload on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    if (parsed.type !== 'geofence.snapshot') {
      return;
    }

    const originSiteId = parsed.originSiteId ?? topicSiteId ?? this.localSiteId;
    if (originSiteId === this.localSiteId) {
      return;
    }

    await this.geofencesService.syncRemoteGeofenceSnapshot(originSiteId, parsed.geofences ?? []);
  }

  private buildUpsertTopic(siteId: string): string {
    return `ahcc/${siteId}/geofences/upsert`;
  }

  private buildDeleteTopic(siteId: string): string {
    return `ahcc/${siteId}/geofences/delete`;
  }

  private buildSnapshotTopic(siteId: string): string {
    return `ahcc/${siteId}/geofences/snapshot`;
  }

  private async sendSnapshotToContext(context: SiteMqttContext): Promise<void> {
    const geofences = await this.geofencesService.list({ includeRemote: false });
    const message: GeofenceSnapshotMessage = {
      type: 'geofence.snapshot',
      originSiteId: this.localSiteId,
      generatedAt: new Date().toISOString(),
      geofences: geofences.map((geofence) => this.mapGeofenceToPayload(geofence)),
    };

    await new Promise<void>((resolve, reject) => {
      context.client.publish(
        this.buildSnapshotTopic(this.localSiteId),
        JSON.stringify(message),
        { qos: context.qosEvents },
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  }

  private mapGeofenceToPayload(geofence: GeofenceEvent['geofence']): GeofenceUpsertPayload {
    return {
      id: geofence.id,
      siteId: geofence.siteId ?? null,
      originSiteId: geofence.originSiteId ?? null,
      name: geofence.name,
      description: geofence.description ?? null,
      color: geofence.color,
      polygon: geofence.polygon,
      alarmEnabled: geofence.alarm.enabled,
      alarmLevel: geofence.alarm.level,
      alarmMessage: geofence.alarm.message,
      alarmTriggerOnExit: geofence.alarm.triggerOnExit ?? false,
      createdBy: geofence.createdBy ?? null,
      createdAt: geofence.createdAt,
      updatedAt: geofence.updatedAt,
      site: geofence.site
        ? {
            id: geofence.site.id,
            name: geofence.site.name ?? null,
            color: geofence.site.color ?? null,
            country: geofence.site.country ?? null,
            city: geofence.site.city ?? null,
          }
        : undefined,
    };
  }
}
