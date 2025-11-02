import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';

import { MqttService, SiteMqttContext } from './mqtt.service';
import {
  CommandState,
  CommandsService,
  ExternalCommandEventInput,
  RemoteCommandRequest,
} from '../commands/commands.service';

type CommandEventMessage = {
  type: 'command.event';
  originSiteId: string;
  commandId: string;
  payload: {
    status: CommandState['status'];
    target: string;
    name: string;
    params: string[];
    userId?: string | null;
    ackKind?: string | null;
    ackStatus?: string | null;
    ackNode?: string | null;
    resultText?: string | null;
    errorText?: string | null;
    createdAt: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    timestamp?: string;
  };
};

type CommandRequestMessage = {
  type: 'command.request';
  originSiteId: string;
  targetSiteId: string;
  commandId: string;
  payload: {
    target: string;
    name: string;
    params: string[];
    line: string;
    userId?: string | null;
  };
};

const COMMAND_EVENT_TOPIC_PATTERN = 'ahcc/+/commands/events';
const COMMAND_REQUEST_TOPIC_PATTERN = 'ahcc/+/commands/request';

@Injectable()
export class MqttCommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttCommandsService.name);
  private readonly localSiteId: string;
  private readonly commandsEnabled: boolean;
  private outboundSubscription?: Subscription;
  private requestSubscription?: Subscription;
  private readonly inboundHandlers = new Map<string, (topic: string, payload: Buffer) => void>();

  constructor(
    configService: ConfigService,
    private readonly commandsService: CommandsService,
    private readonly mqttService: MqttService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
    this.commandsEnabled = configService.get<boolean>('mqtt.commandsEnabled', true);
  }

  onModuleInit(): void {
    if (!this.commandsEnabled) {
      this.logger.log('MQTT command federation disabled via configuration');
      return;
    }

    this.outboundSubscription = this.commandsService.getUpdatesStream().subscribe({
      next: (command) => {
        void this.handleCommandUpdate(command).catch((error) => {
          this.logger.error(
            `Failed to publish MQTT command event ${command.id}: ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
      },
      error: (error) => {
        this.logger.error(
          `Command updates stream error: ${error instanceof Error ? error.message : error}`,
        );
      },
    });

    this.requestSubscription = this.commandsService.getRemoteRequestsStream().subscribe({
      next: (request) => {
        void this.publishCommandRequest(request).catch((error) => {
          this.logger.error(
            `Failed to publish MQTT command request ${request.id}: ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
      },
      error: (error) => {
        this.logger.error(
          `Command request stream error: ${error instanceof Error ? error.message : error}`,
        );
      },
    });

    this.mqttService.onClientConnected((context) => {
      void this.attachInboundSubscriptions(context).catch((error) => {
        this.logger.error(
          `Failed to subscribe command events for site ${context.siteId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.outboundSubscription?.unsubscribe();
    this.requestSubscription?.unsubscribe();
    this.inboundHandlers.forEach((handler, siteId) => {
      const context = this.mqttService.getConnectedContexts().find((ctx) => ctx.siteId === siteId);
      context?.client.removeListener('message', handler);
    });
    this.inboundHandlers.clear();
  }

  private async attachInboundSubscriptions(context: SiteMqttContext): Promise<void> {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        context.client.subscribe(
          COMMAND_EVENT_TOPIC_PATTERN,
          { qos: context.qosEvents ?? 1 },
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
          COMMAND_REQUEST_TOPIC_PATTERN,
          { qos: context.qosCommands ?? 1 },
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
      if (!topic.startsWith('ahcc/')) {
        return;
      }
      if (topic.endsWith('/commands/events')) {
        void this.handleInboundCommandEvent(topic, payload).catch((error) => {
          this.logger.error(
            `Failed processing inbound command event (${topic}): ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
        return;
      }
      if (topic.endsWith('/commands/request')) {
        void this.handleInboundCommandRequest(topic, payload).catch((error) => {
          this.logger.error(
            `Failed processing inbound command request (${topic}): ${
              error instanceof Error ? error.message : error
            }`,
          );
        });
      }
    };

    this.inboundHandlers.set(context.siteId, handler);
    context.client.on('message', handler);
  }

  private async handleCommandUpdate(command: CommandState): Promise<void> {
    const siteId = command.siteId ?? this.localSiteId;
    if (siteId !== this.localSiteId) {
      // Avoid rebroadcast loops for mirrored commands.
      return;
    }

    const topic = this.buildCommandEventTopic(siteId);
    const message: CommandEventMessage = {
      type: 'command.event',
      originSiteId: siteId,
      commandId: command.id,
      payload: {
        status: command.status,
        target: command.target,
        name: command.name,
        params: command.params,
        userId: command.userId ?? null,
        ackKind: command.ackKind ?? null,
        ackStatus: command.ackStatus ?? null,
        ackNode: command.ackNode ?? null,
        resultText: command.resultText ?? null,
        errorText: command.errorText ?? null,
        createdAt: command.createdAt.toISOString(),
        startedAt: command.startedAt ? command.startedAt.toISOString() : null,
        finishedAt: command.finishedAt ? command.finishedAt.toISOString() : null,
        timestamp: new Date().toISOString(),
      },
    };

    await this.mqttService.publishToAll(topic, JSON.stringify(message), undefined, 'commands');
  }

  private async publishCommandRequest(request: RemoteCommandRequest): Promise<void> {
    const topic = this.buildCommandRequestTopic(request.siteId);
    const message: CommandRequestMessage = {
      type: 'command.request',
      originSiteId: this.localSiteId,
      targetSiteId: request.siteId,
      commandId: request.id,
      payload: {
        target: request.target,
        name: request.name,
        params: request.params,
        line: request.line,
        userId: request.userId ?? null,
      },
    };

    await this.mqttService.publishToAll(topic, JSON.stringify(message), { qos: 1 }, 'commands');
  }

  private async handleInboundCommandEvent(topic: string, payload: Buffer): Promise<void> {
    const [, topicSiteId] = topic.split('/');

    let parsed: CommandEventMessage;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as CommandEventMessage;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid command event payload on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    if (parsed.type !== 'command.event') {
      return;
    }

    const originSiteId = parsed.originSiteId ?? topicSiteId ?? this.localSiteId;
    if (originSiteId === this.localSiteId) {
      // Event originated here; already handled locally.
      return;
    }

    const event: ExternalCommandEventInput = {
      id: parsed.commandId,
      siteId: originSiteId,
      target: parsed.payload.target,
      name: parsed.payload.name,
      params: parsed.payload.params,
      status: parsed.payload.status,
      userId: parsed.payload.userId ?? null,
      ackKind: parsed.payload.ackKind ?? null,
      ackStatus: parsed.payload.ackStatus ?? null,
      ackNode: parsed.payload.ackNode ?? null,
      resultText: parsed.payload.resultText ?? null,
      errorText: parsed.payload.errorText ?? null,
      createdAt: parsed.payload.createdAt,
      startedAt: parsed.payload.startedAt ?? null,
      finishedAt: parsed.payload.finishedAt ?? null,
    };

    await this.commandsService.syncExternalCommand(event);
  }

  private async handleInboundCommandRequest(topic: string, payload: Buffer): Promise<void> {
    const [, topicSiteId] = topic.split('/');

    let parsed: CommandRequestMessage;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as CommandRequestMessage;
    } catch (error) {
      this.logger.warn(
        `Ignoring invalid command request payload on ${topic}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      return;
    }

    if (parsed.type !== 'command.request') {
      return;
    }

    const targetSiteId = parsed.targetSiteId ?? topicSiteId;
    if (targetSiteId !== this.localSiteId) {
      return;
    }

    if (parsed.originSiteId === this.localSiteId) {
      // Request originated here; nothing to do.
      return;
    }

    const request: RemoteCommandRequest = {
      id: parsed.commandId,
      siteId: targetSiteId,
      target: parsed.payload.target,
      name: parsed.payload.name,
      params: parsed.payload.params ?? [],
      line: parsed.payload.line,
      userId: parsed.payload.userId ?? null,
    };

    await this.commandsService.executeRemoteRequest(request);
  }

  private buildCommandEventTopic(siteId: string): string {
    return `ahcc/${siteId}/commands/events`;
  }

  private buildCommandRequestTopic(siteId: string): string {
    return `ahcc/${siteId}/commands/request`;
  }
}
