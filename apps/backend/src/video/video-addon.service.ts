import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';

import type { FpvAddonStatus, FpvConfig, FpvFramePayload } from './video.types';

type FpvDecoderModule = typeof import('@command-center/fpv-decoder');
type FpvDecoderFactory = FpvDecoderModule['createFpvDecoder'];
type FpvDecoderInstance = ReturnType<FpvDecoderFactory>;

interface RawFpvFrame {
  width?: number;
  height?: number;
  format?: string;
  mimeType?: string;
  data?: Buffer | Uint8Array | string;
  timestamp?: number;
}

@Injectable()
export class VideoAddonService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoAddonService.name);
  private readonly frameEmitter = new EventEmitter();

  private decoderInstance?: FpvDecoderInstance;
  private decoderFrameUnsubscribe?: () => void;
  private stopHandle?: () => Promise<void> | void;
  private lastFrame?: FpvFramePayload;

  private config: FpvConfig;
  private status: FpvAddonStatus;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      frequencyMHz: this.sanitizeNumber(
        this.configService.get<number>('video.fpvDefaultFrequencyMHz'),
        5760,
      ),
      bandwidthMHz: this.sanitizeNumber(
        this.configService.get<number>('video.fpvDefaultBandwidthMHz'),
        10,
      ),
      gainDb: this.sanitizeNumber(this.configService.get<number>('video.fpvDefaultGainDb'), 40),
    };

    this.status = {
      enabled: false,
      available: false,
      framesReceived: 0,
      config: { ...this.config },
    };
  }

  async onModuleInit(): Promise<void> {
    const enabled = this.configService.get<boolean>('video.fpvEnabled', false);
    this.status.enabled = enabled;

    if (!enabled) {
      this.status.message = 'FPV decoder disabled';
      return;
    }

    await this.tryInitializeDecoder();
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdownDecoder();
  }

  getStatus(): FpvAddonStatus {
    return { ...this.status, config: { ...this.config } };
  }

  getLastFrame(): FpvFramePayload | undefined {
    return this.lastFrame ? { ...this.lastFrame } : undefined;
  }

  onFrame(listener: (frame: FpvFramePayload) => void): () => void {
    this.frameEmitter.on('frame', listener);
    return () => {
      this.frameEmitter.off('frame', listener);
    };
  }

  getConfig(): FpvConfig {
    return { ...this.config };
  }

  async updateConfig(update: Partial<FpvConfig>): Promise<FpvConfig> {
    const next: FpvConfig = {
      frequencyMHz: this.sanitizeNumber(update.frequencyMHz, this.config.frequencyMHz),
      bandwidthMHz: this.sanitizeNumber(update.bandwidthMHz, this.config.bandwidthMHz),
      gainDb: this.sanitizeNumber(update.gainDb, this.config.gainDb),
    };
    this.config = next;
    this.status.config = { ...this.config };

    if (this.decoderInstance?.updateConfig) {
      try {
        this.decoderInstance.updateConfig(this.toDecoderOptions());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`FPV decoder updateConfig failed: ${message}`);
      }
    }

    return this.getConfig();
  }

  private async tryInitializeDecoder(): Promise<void> {
    let factory: FpvDecoderFactory | undefined;

    try {
      ({ createFpvDecoder: factory } = await import('@command-center/fpv-decoder'));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'FPV decoder addon is not installed (install @command-center/fpv-decoder)';
      this.logger.warn(`Unable to load FPV decoder addon: ${message}`);
      this.status.available = false;
      this.status.message = message;
      return;
    }

    try {
      this.decoderInstance = factory(this.toDecoderOptions());
      this.decoderFrameUnsubscribe = this.decoderInstance.onFrame((rawFrame) => {
        this.handleIncomingFrame(rawFrame);
      });

      const handle = await this.decoderInstance.start();

      if (handle?.stop) {
        this.stopHandle = () => handle.stop();
      } else if (typeof this.decoderInstance.stop === 'function') {
        this.stopHandle = () => this.decoderInstance?.stop?.();
      }

      if (this.decoderInstance?.updateConfig) {
        try {
          this.decoderInstance.updateConfig(this.toDecoderOptions());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`FPV decoder updateConfig failed: ${message}`);
        }
      }

      this.status.available = true;
      this.status.message = 'FPV decoder addon loaded';
      this.status.config = { ...this.config };
      this.logger.log('FPV decoder addon initialized (stub)');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to initialize FPV decoder addon';
      this.logger.error(`FPV decoder initialization error: ${message}`);
      this.status.available = false;
      this.status.message = message;
    }
  }

  private handleIncomingFrame(rawFrame: RawFpvFrame | null | undefined): void {
    if (!rawFrame) {
      return;
    }

    try {
      const buffer = Buffer.isBuffer(rawFrame.data)
        ? rawFrame.data
        : rawFrame.data
          ? Buffer.from(rawFrame.data)
          : Buffer.alloc(0);

      const payload: FpvFramePayload = {
        width: typeof rawFrame.width === 'number' ? rawFrame.width : 0,
        height: typeof rawFrame.height === 'number' ? rawFrame.height : 0,
        format: typeof rawFrame.format === 'string' ? rawFrame.format : 'unknown',
        mimeType: rawFrame.mimeType ?? (rawFrame.format === 'svg' ? 'image/svg+xml' : undefined),
        data: buffer.toString('base64'),
        timestamp: new Date(
          typeof rawFrame.timestamp === 'number' ? rawFrame.timestamp : Date.now(),
        ).toISOString(),
      };

      this.status.framesReceived += 1;
      this.status.lastFrameAt = payload.timestamp;
      this.lastFrame = payload;
      this.frameEmitter.emit('frame', payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to process FPV frame: ${message}`);
    }
  }

  private async shutdownDecoder(): Promise<void> {
    try {
      if (this.stopHandle) {
        await this.stopHandle();
      } else if (this.decoderInstance?.stop) {
        await this.decoderInstance.stop();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error stopping FPV decoder addon: ${message}`);
    } finally {
      this.decoderFrameUnsubscribe?.();
      this.decoderFrameUnsubscribe = undefined;
      this.decoderInstance = undefined;
      this.stopHandle = undefined;
      this.lastFrame = undefined;
      this.status.config = { ...this.config };
    }
  }

  private toDecoderOptions() {
    return {
      source: 'soapy-litexm2sdr',
      channel: 0,
      frequencyMHz: this.config.frequencyMHz ?? undefined,
      bandwidthMHz: this.config.bandwidthMHz ?? undefined,
      gainDb: this.config.gainDb ?? undefined,
    };
  }

  private sanitizeNumber(value: unknown, fallback: number | null): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (value === null) {
      return null;
    }
    return fallback;
  }
}
