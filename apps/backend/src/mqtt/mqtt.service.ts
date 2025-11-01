import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, MqttClient } from 'mqtt';

import { PrismaService } from '../prisma/prisma.service';
import { UpdateMqttConfigDto } from './dto/update-mqtt-config.dto';

interface SiteMqttContext {
  siteId: string;
  client: MqttClient;
}

type MqttStatusState = 'not_configured' | 'disabled' | 'connecting' | 'connected' | 'error';

interface SiteStatusEntry {
  state: MqttStatusState;
  message?: string;
  updatedAt: Date;
}

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private readonly clients: SiteMqttContext[] = [];
  private readonly statuses = new Map<string, SiteStatusEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.configService.get<boolean>('mqtt.enabled', true)) {
      this.logger.log('MQTT integration is disabled by configuration');
      return;
    }

    const configs = await this.prisma.mqttConfig.findMany();

    configs.forEach((config) => {
      if (!config.enabled) {
        this.updateStatus(config.siteId, 'disabled', 'MQTT disabled');
      } else {
        this.updateStatus(config.siteId, 'connecting', 'Connecting to broker…');
      }
    });

    await Promise.all(
      configs
        .filter((config) => config.enabled)
        .map(async (config) => {
          try {
            const client = await this.createClient(config);
            this.clients.push({ siteId: config.siteId, client });
            this.logger.log(`Connected MQTT client for site ${config.siteId}`);
            this.updateStatus(config.siteId, 'connected', 'Connected');
          } catch (error) {
            this.logger.error(
              `Failed to connect MQTT for site ${config.siteId}: ${
                error instanceof Error ? error.message : error
              }`,
            );
            const message = error instanceof Error ? error.message : String(error);
            this.updateStatus(config.siteId, 'error', message);
          }
        }),
    );
  }

  onModuleDestroy(): void {
    this.clients.forEach(({ client, siteId }) => {
      this.logger.log(`Disconnecting MQTT client for site ${siteId}`);
      client.end(true);
    });
    this.clients.length = 0;
  }

  async listSiteConfigs() {
    return this.prisma.mqttConfig.findMany({
      include: {
        site: { select: { id: true, name: true, color: true } },
      },
    });
  }

  async getSiteConfig(siteId: string) {
    return this.prisma.mqttConfig.findUnique({
      where: { siteId },
      include: {
        site: { select: { id: true, name: true, color: true } },
      },
    });
  }

  async updateSiteConfig(siteId: string, dto: UpdateMqttConfigDto) {
    const config = await this.prisma.mqttConfig.upsert({
      where: { siteId },
      create: {
        siteId,
        brokerUrl: dto.brokerUrl ?? 'mqtt://localhost:1883',
        clientId: dto.clientId ?? `command-center-${siteId}`,
        username: dto.username ?? null,
        password: dto.password ?? null,
        tlsEnabled: dto.tlsEnabled ?? false,
        caPem: dto.caPem ?? null,
        certPem: dto.certPem ?? null,
        keyPem: dto.keyPem ?? null,
        qosEvents: dto.qosEvents ?? 1,
        qosCommands: dto.qosCommands ?? 1,
        enabled: dto.enabled ?? false,
      },
      update: {
        brokerUrl: dto.brokerUrl ?? undefined,
        clientId: dto.clientId ?? undefined,
        username: dto.username ?? undefined,
        password: dto.password ?? undefined,
        tlsEnabled: dto.tlsEnabled ?? undefined,
        caPem: dto.caPem ?? undefined,
        certPem: dto.certPem ?? undefined,
        keyPem: dto.keyPem ?? undefined,
        qosEvents: dto.qosEvents ?? undefined,
        qosCommands: dto.qosCommands ?? undefined,
        enabled: dto.enabled ?? undefined,
      },
      include: {
        site: { select: { id: true, name: true, color: true } },
      },
    });

    await this.restartClient(siteId);
    return config;
  }

  async listStatuses() {
    return Array.from(this.statuses.entries()).map(([siteId, entry]) => ({
      siteId,
      state: entry.state,
      message: entry.message,
      updatedAt: entry.updatedAt.toISOString(),
    }));
  }

  async getSiteStatus(siteId: string) {
    const entry = this.statuses.get(siteId);
    if (!entry) {
      return {
        siteId,
        state: 'not_configured' as const,
        message: 'No MQTT configuration saved.',
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      siteId,
      state: entry.state,
      message: entry.message,
      updatedAt: entry.updatedAt.toISOString(),
    };
  }

  async reconnectSite(siteId: string) {
    await this.restartClient(siteId);
    return this.getSiteStatus(siteId);
  }

  async testSiteConnection(siteId: string) {
    const config = await this.prisma.mqttConfig.findUnique({ where: { siteId } });
    if (!config) {
      throw new NotFoundException(`No MQTT configuration found for site ${siteId}`);
    }

    try {
      const client = await this.createClient(config);
      client.end(true);
      const message = config.enabled
        ? 'Connection successful.'
        : 'Connection successful (configuration is currently disabled).';
      this.updateStatus(siteId, 'connected', message);
      return {
        ok: true,
        state: 'connected' as const,
        message,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus(siteId, 'error', message);
      return {
        ok: false,
        state: 'error' as const,
        message,
      };
    }
  }

  private async restartClient(siteId: string): Promise<void> {
    const existingIndex = this.clients.findIndex((ctx) => ctx.siteId === siteId);
    if (existingIndex >= 0) {
      const existing = this.clients[existingIndex];
      this.logger.log(`Restarting MQTT client for site ${siteId}`);
      existing.client.end(true);
      this.clients.splice(existingIndex, 1);
    }

    const config = await this.prisma.mqttConfig.findUnique({ where: { siteId } });
    if (!config || !config.enabled) {
      this.updateStatus(
        siteId,
        config ? 'disabled' : 'not_configured',
        config ? 'MQTT disabled' : 'No MQTT configuration saved.',
      );
      return;
    }

    this.updateStatus(siteId, 'connecting', 'Connecting to broker…');

    try {
      const client = await this.createClient(config);
      this.clients.push({ siteId, client });
      this.logger.log(`Reconnected MQTT client for site ${siteId}`);
      this.updateStatus(siteId, 'connected', 'Connected');
    } catch (error) {
      this.logger.error(
        `Failed to reconnect MQTT client for site ${siteId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus(siteId, 'error', message);
    }
  }

  private async createClient(config: {
    brokerUrl: string;
    clientId: string;
    username: string | null;
    password: string | null;
    tlsEnabled: boolean;
    caPem: string | null;
    certPem: string | null;
    keyPem: string | null;
  }): Promise<MqttClient> {
    const options: Record<string, unknown> = {
      clientId: config.clientId,
      clean: true,
      reconnectPeriod: 5_000,
    };

    if (config.username) {
      options.username = config.username;
    }
    if (config.password) {
      options.password = config.password;
    }

    if (config.tlsEnabled) {
      options.rejectUnauthorized = false;
      if (config.caPem) {
        options.ca = config.caPem;
      }
      if (config.certPem) {
        options.cert = config.certPem;
      }
      if (config.keyPem) {
        options.key = config.keyPem;
      }
    }

    return new Promise((resolve, reject) => {
      const client = connect(config.brokerUrl, options);

      const onError = (error: Error) => {
        client.removeListener('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        client.removeListener('error', onError);
        resolve(client);
      };

      client.once('error', onError);
      client.once('connect', onConnect);
    });
  }

  private updateStatus(siteId: string, state: MqttStatusState, message?: string) {
    this.statuses.set(siteId, {
      state,
      message,
      updatedAt: new Date(),
    });
  }
}
