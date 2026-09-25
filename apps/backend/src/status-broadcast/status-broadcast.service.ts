import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Subscription } from 'rxjs';

import { buildStatusFrame, isStatusRequestFor } from './status-frame';
import { AppConfigService } from '../app-config/app-config.service';
import { SerialService } from '../serial/serial.service';

const FIRST_RUN_DELAY_MS = 30_000;
const GPS_MAX_AGE_MS = 10 * 60_000;

export interface StatusBroadcastResult {
  at: string;
  sent: boolean;
  frame?: string;
  reason?: string;
}

@Injectable()
export class StatusBroadcastService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StatusBroadcastService.name);
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private subscription?: Subscription;
  private pending = false;
  private last: StatusBroadcastResult | null = null;

  constructor(
    private readonly serial: SerialService,
    private readonly appConfig: AppConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.serial.ownsPort()) {
      return;
    }
    this.subscription = this.serial.getIncomingStream().subscribe((text) => {
      void this.handleIncoming(text);
    });
    this.schedule(FIRST_RUN_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  lastResult(): StatusBroadcastResult | null {
    return this.last;
  }

  async trigger(): Promise<StatusBroadcastResult> {
    return this.broadcast();
  }

  private schedule(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    let intervalSec = 600;
    try {
      const settings = await this.appConfig.getSettings();
      intervalSec = Math.min(3600, Math.max(60, settings.statusBroadcastIntervalSec));
      if (settings.statusBroadcastEnabled) {
        await this.broadcast();
      }
    } catch (error) {
      this.logger.warn(
        `Status broadcast tick failed: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.schedule(intervalSec * 1000);
    }
  }

  private async handleIncoming(text: string): Promise<void> {
    const { radio } = await this.serial.getRadioInfo();
    if (!isStatusRequestFor(text, radio.shortName) || this.pending) {
      return;
    }
    const settings = await this.appConfig.getSettings();
    if (!settings.statusReplyEnabled) {
      return;
    }
    this.pending = true;
    try {
      await this.broadcast();
    } finally {
      this.pending = false;
    }
  }

  private async broadcast(): Promise<StatusBroadcastResult> {
    const settings = await this.appConfig.getSettings();
    const { radio, meshNodeCount } = await this.serial.getRadioInfo();
    const name = radio.shortName || (radio.num ? `!${radio.num.toString(16)}` : undefined);
    if (!name) {
      return this.record({ sent: false, reason: 'Radio not identified yet' });
    }
    const gpsFresh =
      radio.positionAt !== undefined && Date.now() - radio.positionAt < GPS_MAX_AGE_MS;
    const frame = buildStatusFrame({
      name,
      hits: meshNodeCount,
      tempC: await readHostTempC(),
      uptimeSec: (Date.now() - this.startedAt) / 1000,
      lat: settings.statusBroadcastGps && gpsFresh ? radio.lat : undefined,
      lon: settings.statusBroadcastGps && gpsFresh ? radio.lon : undefined,
      batteryLevel: radio.batteryLevel,
    });
    try {
      await this.serial.queueCommand({
        id: randomUUID(),
        target: '@ALL',
        name: 'STATUS',
        params: [],
        line: frame,
      });
      this.logger.log(`Status broadcast sent (${frame.length} chars)`);
      return this.record({ sent: true, frame });
    } catch (error) {
      return this.record({
        sent: false,
        frame,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private record(result: Omit<StatusBroadcastResult, 'at'>): StatusBroadcastResult {
    this.last = { at: new Date().toISOString(), ...result };
    return this.last;
  }
}

async function readHostTempC(): Promise<number | undefined> {
  try {
    const raw = await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    const milli = Number(raw.trim());
    return Number.isFinite(milli) ? milli / 1000 : undefined;
  } catch {
    return undefined;
  }
}
