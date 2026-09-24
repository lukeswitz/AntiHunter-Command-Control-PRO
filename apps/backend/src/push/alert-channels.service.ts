import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AlarmLevel, RemoteAlertConfig } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { MatterService } from './matter.service';
import { PushService } from './push.service';
import { isAllowedChannelUrl, RemoteAlertConfigService } from './remote-alert-config.service';

const NTFY_PRIORITY: Record<AlarmLevel, string> = {
  INFO: '2',
  NOTICE: '3',
  ALERT: '4',
  CRITICAL: '5',
};

export type AlertChannel = 'push' | 'ntfy' | 'signal' | 'matrix' | 'matter';

function httpsOrLoopback(raw: string | null): URL | null {
  return raw && isAllowedChannelUrl(raw) ? new URL(raw) : null;
}

@Injectable()
export class AlertChannelsService {
  private readonly logger = new Logger(AlertChannelsService.name);

  constructor(
    private readonly push: PushService,
    private readonly matter: MatterService,
    private readonly config: RemoteAlertConfigService,
  ) {}

  async alert(title: string, body: string, severity?: AlarmLevel | null): Promise<void> {
    const config = await this.config.get();
    this.matter.trigger(severity ?? null);
    await Promise.all([
      this.run('push', () => this.push.notify(title, body)),
      config.ntfyEnabled
        ? this.run('ntfy', () => this.sendNtfy(config, title, body, severity))
        : null,
      config.signalEnabled
        ? this.run('signal', () => this.sendSignal(config, `${title}\n${body}`))
        : null,
      config.matrixEnabled
        ? this.run('matrix', () => this.sendMatrix(config, `${title}\n${body}`))
        : null,
    ]);
  }

  async test(channel: AlertChannel): Promise<void> {
    const config = await this.config.get();
    const title = 'AntiHunter test';
    const body = `Test notification from AntiHunter Command Center\nTime: ${new Date().toISOString()}`;
    switch (channel) {
      case 'push':
        return this.push.notify(title, body);
      case 'ntfy':
        return this.sendNtfy(config, title, body, 'NOTICE', true);
      case 'signal':
        return this.sendSignal(config, `${title}\n${body}`, true);
      case 'matrix':
        return this.sendMatrix(config, `${title}\n${body}`, true);
      case 'matter':
        this.matter.trigger('CRITICAL');
        return;
      default:
        throw new BadRequestException('Unknown channel');
    }
  }

  private async run(channel: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.warn(
        `${channel} delivery failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private missing(strict: boolean, what: string): void {
    if (strict) {
      throw new BadRequestException(`${what} is not configured`);
    }
  }

  private async sendNtfy(
    config: RemoteAlertConfig,
    title: string,
    body: string,
    severity?: AlarmLevel | null,
    strict = false,
  ) {
    const url = httpsOrLoopback(config.ntfyUrl);
    if (!url) {
      return this.missing(strict, 'ntfy topic URL');
    }
    const headers: Record<string, string> = {
      Title: title,
      Priority: NTFY_PRIORITY[severity ?? 'NOTICE'],
      Tags:
        severity === 'CRITICAL' ? 'rotating_light' : severity === 'ALERT' ? 'warning' : 'satellite',
    };
    if (config.ntfyToken) {
      headers.Authorization = `Bearer ${config.ntfyToken}`;
    }
    await this.post(url, { method: 'POST', headers, body });
  }

  private async sendSignal(config: RemoteAlertConfig, message: string, strict = false) {
    const url = httpsOrLoopback(config.signalApiUrl);
    if (!url || !config.signalNumber || !config.signalRecipients.length) {
      return this.missing(strict, 'Signal API URL, number and recipients');
    }
    await this.post(new URL('/v2/send', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        number: config.signalNumber,
        recipients: config.signalRecipients,
      }),
    });
  }

  private async sendMatrix(config: RemoteAlertConfig, message: string, strict = false) {
    const url = httpsOrLoopback(config.matrixHomeserverUrl);
    if (!url || !config.matrixAccessToken || !config.matrixRoomId) {
      return this.missing(strict, 'Matrix homeserver, access token and room');
    }
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(config.matrixRoomId)}/send/m.room.message/${randomUUID()}`;
    await this.post(new URL(path, url), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.matrixAccessToken}`,
      },
      body: JSON.stringify({ msgtype: 'm.text', body: message }),
    });
  }

  private async post(url: URL, init: RequestInit) {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }
}
