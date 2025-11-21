import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

import { ChatClearEvent, ChatMessageEvent } from './chat.types';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { AuthTokenPayload } from '../auth/auth.types';
import { MqttService } from '../mqtt/mqtt.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly localSiteId: string;

  constructor(
    configService: ConfigService,
    private readonly mqttService: MqttService,
    private readonly gateway: CommandCenterGateway,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
  }

  async sendMessage(dto: SendChatMessageDto, auth?: AuthTokenPayload): Promise<ChatMessageEvent> {
    const siteId = (dto.siteId ?? this.localSiteId ?? 'default').trim();
    const encrypted = Boolean(dto.encrypted ?? dto.cipherText);

    if (encrypted && !dto.cipherText) {
      throw new Error('Encrypted messages require cipherText');
    }
    if (!encrypted && !dto.text) {
      throw new Error('Missing message text');
    }

    const message: ChatMessageEvent = {
      type: 'chat.message',
      id: randomUUID(),
      siteId,
      originSiteId: siteId,
      fromUserId: auth?.sub,
      fromEmail: auth?.email,
      fromRole: auth?.role,
      fromDisplayName: this.buildDisplayName(auth),
      encrypted,
      text: encrypted ? undefined : dto.text?.trim(),
      cipherText: encrypted ? dto.cipherText : undefined,
      ts: new Date().toISOString(),
    };

    const topic = this.buildTopic(siteId);

    // Emit locally to connected clients.
    this.gateway.emitEvent(message, { skipBus: true });

    try {
      await this.mqttService.publishToAll(topic, JSON.stringify(message));
    } catch (error) {
      this.logger.warn(
        `Failed to publish chat message ${message.id} on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      // Still return the message so the sender sees it; remote delivery may have failed.
    }

    return message;
  }

  async clearAll(auth?: AuthTokenPayload, target: 'all' | string = 'all'): Promise<ChatClearEvent> {
    if (auth?.role !== 'ADMIN') {
      throw new Error('Only ADMIN can clear chat history for all sites');
    }
    const event: ChatClearEvent = {
      type: 'chat.clear',
      originSiteId: this.localSiteId,
      target,
      ts: new Date().toISOString(),
    };
    this.gateway.emitEvent(event, { skipBus: true });
    try {
      await this.mqttService.publishToAll(this.buildClearTopic(target), JSON.stringify(event));
    } catch (error) {
      this.logger.warn(
        `Failed to publish chat clear event on ${this.buildClearTopic(target)}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
    return event;
  }

  private buildTopic(siteId: string): string {
    return `ahcc/${siteId}/chat`;
  }

  private buildClearTopic(target: 'all' | string): string {
    return target === 'all' ? 'ahcc/+/chat' : this.buildTopic(target);
  }

  private buildDisplayName(auth?: AuthTokenPayload): string | null {
    if (!auth) return null;
    if (auth.email) return auth.email;
    return auth.sub ?? null;
  }
}
