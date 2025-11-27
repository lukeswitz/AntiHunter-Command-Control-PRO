import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { clearInterval as clearIntervalSafe, setInterval as setIntervalSafe } from 'node:timers';

import type { AdsbStatus, AdsbTrack } from './adsb.types';
import { CommandCenterGateway } from '../ws/command-center.gateway';

interface Dump1090Aircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number;
  alt_geom?: number;
  gs?: number;
  track?: number;
  seen?: number;
  seen_pos?: number;
  rssi?: number;
  nav_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  category?: string;
  squawk?: string;
  nav_modes?: string;
}

@Injectable()
export class AdsbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdsbService.name);
  private enabled: boolean;
  private feedUrl: string;
  private intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private tracks: Map<string, AdsbTrack> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly gateway: CommandCenterGateway,
  ) {
    this.enabled = this.configService.get<boolean>('adsb.enabled', false) ?? false;
    this.feedUrl =
      this.configService.get<string>('adsb.feedUrl', 'http://127.0.0.1:8080/data/aircraft.json') ??
      'http://127.0.0.1:8080/data/aircraft.json';
    this.intervalMs = this.configService.get<number>('adsb.pollIntervalMs', 15000) ?? 15000;
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.startPolling();
    }
  }

  onModuleDestroy(): void {
    this.stopPolling();
  }

  getStatus(): AdsbStatus {
    return {
      enabled: this.enabled,
      feedUrl: this.feedUrl,
      intervalMs: this.intervalMs,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      trackCount: this.tracks.size,
    };
  }

  getFeedUrl(): string {
    return this.feedUrl;
  }

  getTracks(): AdsbTrack[] {
    return Array.from(this.tracks.values());
  }

  updateConfig(config: { enabled?: boolean; feedUrl?: string; intervalMs?: number }): AdsbStatus {
    if (config.enabled !== undefined) {
      this.enabled = Boolean(config.enabled);
    }
    if (config.feedUrl) {
      this.feedUrl = config.feedUrl.trim();
    }
    if (config.intervalMs && Number.isFinite(config.intervalMs)) {
      this.intervalMs = Math.max(2000, Number(config.intervalMs));
    }

    this.stopPolling();
    if (this.enabled) {
      this.startPolling();
    }
    return this.getStatus();
  }

  private startPolling(): void {
    this.timer = setIntervalSafe(() => {
      void this.poll().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.warn(`ADSB poll failed: ${this.lastError}`);
      });
    }, this.intervalMs);
    void this.poll().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.warn(`ADSB initial poll failed: ${this.lastError}`);
    });
  }

  private stopPolling(): void {
    if (this.timer) {
      clearIntervalSafe(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const response = await fetch(this.feedUrl);
    if (!response.ok) {
      throw new Error(`ADSB feed error: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { aircraft?: Dump1090Aircraft[] };
    const aircraft = Array.isArray(payload.aircraft) ? payload.aircraft : [];
    const nextTracks: Map<string, AdsbTrack> = new Map();

    aircraft.forEach((entry) => {
      if (typeof entry.lat !== 'number' || typeof entry.lon !== 'number') {
        return;
      }
      const hex = (entry.hex ?? '').trim().toUpperCase();
      if (!hex) {
        return;
      }
      const id = hex;
      const callsign = (entry.flight ?? '').trim() || null;
      const alt = entry.alt_geom ?? entry.alt_baro ?? null;
      const track: AdsbTrack = {
        id,
        icao: hex,
        callsign,
        lat: entry.lat,
        lon: entry.lon,
        alt: typeof alt === 'number' ? alt : null,
        speed: typeof entry.gs === 'number' ? entry.gs : null,
        heading: typeof entry.track === 'number' ? entry.track : null,
        onGround: null,
        lastSeen: new Date(Date.now() - (entry.seen ?? 0) * 1000).toISOString(),
      };
      nextTracks.set(id, track);
    });

    this.tracks = nextTracks;
    this.lastPollAt = new Date().toISOString();
    this.lastError = null;
    this.gateway.emitEvent(
      { type: 'adsb.tracks', tracks: Array.from(this.tracks.values()) },
      { skipBus: true },
    );
  }
}
