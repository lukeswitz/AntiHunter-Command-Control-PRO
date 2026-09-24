import { BadRequestException, Injectable } from '@nestjs/common';
import { RemoteAlertConfig } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export type RemoteAlertConfigUpdate = Partial<
  Omit<RemoteAlertConfig, 'id' | 'updatedAt' | 'vapidPublicKey' | 'vapidPrivateKey'>
>;

const SECRET_FIELDS = ['ntfyToken', 'matrixAccessToken'] as const;
const URL_FIELDS = ['ntfyUrl', 'signalApiUrl', 'matrixHomeserverUrl'] as const;

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function list(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isAllowedChannelUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const internal = !url.hostname.includes('.') && !url.hostname.includes(':');
    return url.protocol === 'https:' || (url.protocol === 'http:' && (loopback || internal));
  } catch {
    return false;
  }
}

@Injectable()
export class RemoteAlertConfigService {
  private cached: RemoteAlertConfig | null = null;
  private readonly listeners = new Set<(config: RemoteAlertConfig) => void>();

  constructor(private readonly prisma: PrismaService) {}

  onChange(listener: (config: RemoteAlertConfig) => void): void {
    this.listeners.add(listener);
  }

  async get(): Promise<RemoteAlertConfig> {
    if (this.cached) {
      return this.cached;
    }
    const existing = await this.prisma.remoteAlertConfig.findUnique({ where: { id: 1 } });
    this.cached =
      existing ??
      (await this.prisma.remoteAlertConfig.create({
        data: {
          id: 1,
          tsAllowedLogins: list(env('TS_ALLOWED_LOGINS')).map((login) => login.toLowerCase()),
          vapidPublicKey: env('VAPID_PUBLIC_KEY'),
          vapidPrivateKey: env('VAPID_PRIVATE_KEY'),
          vapidSubject: env('VAPID_SUBJECT'),
          ntfyEnabled: Boolean(env('NTFY_URL')),
          ntfyUrl: env('NTFY_URL'),
          ntfyToken: env('NTFY_TOKEN'),
          signalEnabled: Boolean(env('SIGNAL_NUMBER')),
          signalApiUrl: env('SIGNAL_API_URL'),
          signalNumber: env('SIGNAL_NUMBER'),
          signalRecipients: list(env('SIGNAL_RECIPIENTS')),
          matrixEnabled: Boolean(env('MATRIX_ACCESS_TOKEN')),
          matrixHomeserverUrl: env('MATRIX_HOMESERVER_URL'),
          matrixAccessToken: env('MATRIX_ACCESS_TOKEN'),
          matrixRoomId: env('MATRIX_ROOM_ID'),
          matterEnabled: env('AHCC_MATTER_ENABLED') === 'true',
          matterLayout: env('AHCC_MATTER_LAYOUT') === 'flat' ? 'flat' : 'bridge',
        },
      }));
    return this.cached;
  }

  async update(input: RemoteAlertConfigUpdate): Promise<RemoteAlertConfig> {
    const data: RemoteAlertConfigUpdate = { ...input };
    for (const field of SECRET_FIELDS) {
      if (data[field] === '') {
        delete data[field];
      }
    }
    for (const field of URL_FIELDS) {
      const value = data[field];
      if (typeof value === 'string' && value.trim() && !isAllowedChannelUrl(value.trim())) {
        throw new BadRequestException(
          `${field} must be https, or http to localhost or a docker service name`,
        );
      }
    }
    if (data.tsAllowedLogins) {
      data.tsAllowedLogins = data.tsAllowedLogins
        .map((login) => login.trim().toLowerCase())
        .filter(Boolean);
    }
    if (data.signalRecipients) {
      data.signalRecipients = data.signalRecipients.map((value) => value.trim()).filter(Boolean);
    }
    if (data.matterLayout && !['bridge', 'flat'].includes(data.matterLayout)) {
      throw new BadRequestException('matterLayout must be bridge or flat');
    }
    await this.get();
    return this.save(data);
  }

  async clearSecret(field: 'ntfyToken' | 'matrixAccessToken'): Promise<RemoteAlertConfig> {
    await this.get();
    return this.save({ [field]: null });
  }

  async setVapidKeys(publicKey: string, privateKey: string): Promise<RemoteAlertConfig> {
    await this.get();
    return this.save({ vapidPublicKey: publicKey, vapidPrivateKey: privateKey } as never);
  }

  private async save(data: Partial<RemoteAlertConfig>): Promise<RemoteAlertConfig> {
    this.cached = await this.prisma.remoteAlertConfig.update({ where: { id: 1 }, data });
    for (const listener of this.listeners) {
      listener(this.cached);
    }
    return this.cached;
  }
}
