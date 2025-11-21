import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ChatMessageEvent } from './chat.types';
import { MqttService, SiteMqttContext } from '../mqtt/mqtt.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

const CHAT_TOPIC_PATTERN = 'ahcc/+/chat';

@Injectable()
export class ChatMqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatMqttService.name);
  private readonly localSiteId: string;
  private readonly inboundHandlers = new Map<string, (topic: string, payload: Buffer) => void>();

  constructor(
    configService: ConfigService,
    private readonly mqttService: MqttService,
    private readonly gateway: CommandCenterGateway,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
  }

  onModuleInit(): void {
    this.mqttService.onClientConnected((context) => {
      void this.attachSubscription(context).catch((error) => {
        this.logger.error(
          `Failed to attach chat subscriptions for site ${context.siteId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.inboundHandlers.forEach((handler, siteId) => {
      const context = this.mqttService.getConnectedContexts().find((ctx) => ctx.siteId === siteId);
      context?.client.removeListener('message', handler);
    });
    this.inboundHandlers.clear();
  }

  private async attachSubscription(context: SiteMqttContext): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      context.client.subscribe(CHAT_TOPIC_PATTERN, { qos: context.qosEvents }, (err) => {
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
      if (!topic.includes('/chat')) {
        return;
      }
      void this.handleInbound(payload, topic).catch((error) => {
        this.logger.error(
          `Failed processing inbound chat message (${topic}): ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    };

    this.inboundHandlers.set(context.siteId, handler);
    context.client.on('message', handler);
  }

  private async handleInbound(payload: Buffer, topic: string): Promise<void> {
    let message: ChatMessageEvent;
    try {
      message = JSON.parse(payload.toString('utf8')) as ChatMessageEvent;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid chat payload on ${topic}: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    if (message.type !== 'chat.message') {
      return;
    }

    const originSite = message.originSiteId ?? message.siteId ?? this.localSiteId;
    if (originSite === this.localSiteId) {
      // Already emitted locally.
      return;
    }

    const normalized: ChatMessageEvent = {
      ...message,
      type: 'chat.message',
      siteId: message.siteId ?? originSite,
      originSiteId: originSite,
      ts: message.ts ?? new Date().toISOString(),
    };

    this.gateway.emitEvent(normalized, { skipBus: true });
  }
}
