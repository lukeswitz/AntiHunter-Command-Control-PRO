import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlarmLevel } from '@prisma/client';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import readline from 'node:readline';
import { clearInterval as clearIntervalSafe, setInterval as setIntervalSafe } from 'node:timers';
import { Subscription } from 'rxjs';

import type { AdsbStatus, AdsbTrack } from './adsb.types';
import {
  GeofenceEvent,
  GeofenceResponse,
  GeofencesService,
  GeofenceVertex,
} from '../geofences/geofences.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

function validateFeedUrl(urlString: string): string {
  const parsed = new URL(urlString);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS protocols are allowed');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === '169.254.169.254' ||
    host === 'metadata.google.internal' ||
    host === 'metadata.aws.internal'
  ) {
    throw new Error('Access to cloud metadata endpoints is not allowed');
  }
  return urlString;
}

type AircraftDbEntry = {
  typeCode?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  aircraftType?: string | null;
  categoryDescription?: string | null;
  registration?: string | null;
};

type AirportInfo = {
  icao?: string | null;
  iata?: string | null;
  name?: string | null;
  city?: string | null;
  country?: string | null;
};

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
  reg?: string;
  reg_num?: string;
  r?: string;
  dep?: string;
  dest?: string;
  cntry?: string;
  country?: string;
  messages?: number;
}

@Injectable()
export class AdsbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdsbService.name);
  private readonly hardDisabled: boolean;
  private enabled: boolean;
  private feedUrl: string;
  private intervalMs: number;
  private geofencesEnabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private geofenceSubscription?: Subscription;
  private geofences: GeofenceResponse[] = [];
  private geofenceStates: Map<string, Map<string, boolean>> = new Map();
  private tracks: Map<string, AdsbTrack> = new Map();
  private sessionLog: Map<string, AdsbTrack> = new Map();
  private readonly localSiteId: string;
  private readonly dataDir: string;
  private readonly aircraftDbPath: string;
  private readonly airportsPath: string;
  private readonly configPath: string;
  private openskyEnabled: boolean;
  private openskyClientId?: string;
  private openskyClientSecret?: string;
  private openskyTokenUrl: string;
  private planespottersEnabled: boolean;
  private openskyAccessToken?: string;
  private openskyTokenExpiryMs = 0;
  private readonly routeCache: Map<
    string,
    { dep: string | null; dest: string | null; ts: number }
  > = new Map();
  private static readonly ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
  private readonly photoCache: Map<
    string,
    {
      url: string | null;
      thumb: string | null;
      author: string | null;
      sourceUrl: string | null;
      ts: number;
    }
  > = new Map();
  private static readonly PHOTO_CACHE_TTL_MS = 60 * 60 * 1000;
  private readonly openskyCredentialsFile: string;
  private aircraftDb: Map<string, AircraftDbEntry> = new Map();
  private aircraftDbCount = 0;
  private airportsByIcao: Map<string, AirportInfo> = new Map();
  private airportsByIata: Map<string, AirportInfo> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly geofencesService: GeofencesService,
    private readonly gateway: CommandCenterGateway,
  ) {
    const envEnabled = process.env.ADSB_ENABLED;
    this.hardDisabled = envEnabled === 'false';
    const cfgToggle = this.configService.get<boolean>('adsb.enabled');
    const resolved = envEnabled !== undefined ? envEnabled === 'true' : cfgToggle;
    this.enabled = this.hardDisabled ? false : (resolved ?? true);
    this.feedUrl =
      this.configService.get<string>('adsb.feedUrl', 'http://127.0.0.1:8080/data/aircraft.json') ??
      'http://127.0.0.1:8080/data/aircraft.json';
    this.intervalMs = this.configService.get<number>('adsb.pollIntervalMs', 15000) ?? 15000;
    this.geofencesEnabled =
      this.configService.get<boolean>('adsb.geofencesEnabled', false) ?? false;
    this.openskyEnabled = this.configService.get<boolean>('adsb.openskyEnabled', false) ?? false;
    this.openskyClientId = this.configService.get<string>('adsb.openskyClientId');
    this.openskyClientSecret = this.configService.get<string>('adsb.openskyClientSecret');
    this.openskyTokenUrl =
      this.configService.get<string>('adsb.openskyTokenUrl') ??
      'https://opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
    this.planespottersEnabled =
      this.configService.get<boolean>('adsb.planespottersEnabled', true) ?? true;
    this.localSiteId = this.configService.get<string>('site.id', 'default');
    const baseDir = join(__dirname, '..', '..');
    this.dataDir = join(baseDir, 'data', 'adsb');
    this.aircraftDbPath = join(this.dataDir, 'aircraft-database.csv');
    this.airportsPath = join(this.dataDir, 'airports.dat');
    this.configPath = join(this.dataDir, 'config.json');
    this.openskyCredentialsFile =
      this.configService.get<string>('adsb.openskyCredentialsPath') ??
      join(this.dataDir, 'opensky-credentials.json');
    this.loadOpenskyCredentialsFromFile().catch((error) => {
      this.logger.debug(
        `OpenSky credential file load skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async onModuleInit(): Promise<void> {
    await this.refreshGeofences();
    await this.loadConfigFromDisk();
    this.geofenceSubscription = this.geofencesService
      .getChangesStream()
      .subscribe((event) => this.handleGeofenceChange(event));
    void this.loadAircraftDatabaseFromDisk().catch((error) => {
      this.logger.warn(
        `ADS-B aircraft database not loaded: ${error instanceof Error ? error.message : error}`,
      );
    });
    void this.loadAirportsDatabaseFromDisk().catch((error) => {
      this.logger.warn(
        `ADS-B airports database not loaded: ${error instanceof Error ? error.message : error}`,
      );
    });
    if (this.enabled) {
      this.startPolling();
    }
  }

  onModuleDestroy(): void {
    this.stopPolling();
    this.geofenceSubscription?.unsubscribe();
  }

  getStatus(): AdsbStatus {
    return {
      enabled: this.enabled,
      feedUrl: this.feedUrl,
      intervalMs: this.intervalMs,
      geofencesEnabled: this.geofencesEnabled,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      trackCount: this.tracks.size,
      aircraftDbCount: this.aircraftDbCount,
      openskyEnabled: this.openskyEnabled,
      openskyClientId: this.openskyClientId ?? null,
      // Note: planespottersEnabled is intentionally not exposed to clients to avoid toggling in UI yet
    };
  }

  getFeedUrl(): string {
    return this.feedUrl;
  }

  getTracks(): AdsbTrack[] {
    return Array.from(this.tracks.values());
  }

  getSessionLog(): AdsbTrack[] {
    return Array.from(this.sessionLog.values());
  }

  clearSessionLog(): void {
    this.sessionLog.clear();
    this.logger.log('Cleared ADS-B session log');
  }

  updateConfig(config: {
    enabled?: boolean;
    feedUrl?: string;
    intervalMs?: number;
    geofencesEnabled?: boolean;
    openskyEnabled?: boolean;
    openskyClientId?: string | null;
    openskyClientSecret?: string | null;
    planespottersEnabled?: boolean;
  }): AdsbStatus {
    if (this.hardDisabled) {
      this.enabled = false;
    } else if (config.enabled !== undefined) {
      this.enabled = Boolean(config.enabled);
    }
    if (config.feedUrl !== undefined) {
      const trimmed = String(config.feedUrl).trim();
      validateFeedUrl(trimmed);
      this.feedUrl = trimmed;
    }
    if (config.intervalMs && Number.isFinite(config.intervalMs)) {
      this.intervalMs = Math.max(2000, Number(config.intervalMs));
    }
    if (config.geofencesEnabled !== undefined) {
      this.geofencesEnabled = Boolean(config.geofencesEnabled);
      if (!this.geofencesEnabled) {
        this.geofenceStates.clear();
      } else {
        void this.refreshGeofences();
      }
    }
    if (config.openskyEnabled !== undefined) {
      this.openskyEnabled = Boolean(config.openskyEnabled);
    }
    if (config.planespottersEnabled !== undefined) {
      this.planespottersEnabled = Boolean(config.planespottersEnabled);
    }
    if (config.openskyClientId !== undefined) {
      const trimmed = config.openskyClientId?.trim() || null;
      this.openskyClientId = trimmed || undefined;
    }
    if (config.openskyClientSecret !== undefined) {
      const trimmed = config.openskyClientSecret?.trim() || null;
      this.openskyClientSecret = trimmed || undefined;
    }

    this.stopPolling();
    if (this.enabled) {
      this.startPolling();
    }
    void this.persistConfig();
    return this.getStatus();
  }

  async saveAircraftDatabase(fileName: string, content: Buffer): Promise<{ saved: boolean }> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const basename = (fileName || 'aircraft-database.csv')
        .replace(/^.*[/\\]/, '')
        .replace(/\.\./g, '');
      if (!basename || basename.length === 0) {
        throw new Error('Invalid filename');
      }
      const targetPath = join(this.dataDir, basename);
      if (!targetPath.startsWith(this.dataDir)) {
        throw new Error('Invalid file path');
      }
      await writeFile(targetPath, content);
      this.logger.log(`Saved aircraft database to ${targetPath}`);
      await this.loadAircraftDatabaseFromDisk(targetPath);
      return { saved: true };
    } catch (error) {
      this.logger.error(
        `Failed to save aircraft database: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async saveOpenskyCredentials(fileName: string, content: Buffer): Promise<{ saved: boolean }> {
    await mkdir(this.dataDir, { recursive: true });
    const targetPath = this.openskyCredentialsFile;
    const parsed = JSON.parse(content.toString('utf8')) as {
      clientId?: string;
      clientSecret?: string;
      tokenUrl?: string;
    };
    if (!parsed.clientId || !parsed.clientSecret) {
      throw new Error('Credentials JSON must include clientId and clientSecret');
    }
    await writeFile(targetPath, JSON.stringify(parsed, null, 2), 'utf8');
    this.openskyClientId = parsed.clientId.trim();
    this.openskyClientSecret = parsed.clientSecret.trim();
    if (parsed.tokenUrl && parsed.tokenUrl.trim()) {
      this.openskyTokenUrl = parsed.tokenUrl.trim();
    }
    this.openskyAccessToken = undefined;
    this.openskyTokenExpiryMs = 0;
    await this.persistConfig();
    this.logger.log(`Saved OpenSky credentials to ${targetPath}`);
    return { saved: true };
  }

  private async loadAircraftDatabaseFromDisk(path = this.aircraftDbPath): Promise<void> {
    if (!path.startsWith(this.dataDir)) {
      throw new Error('Invalid database path');
    }
    if (!existsSync(path)) {
      return;
    }
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header: string[] | null = null;
    const next = new Map<string, AircraftDbEntry>();
    for await (const line of rl) {
      if (!header) {
        header = this.parseCsvLine(line);
        continue;
      }
      if (!line.trim()) {
        continue;
      }
      const cols = this.parseCsvLine(line);
      if (cols.length === 0) {
        continue;
      }
      const icao24 = this.getColumn(cols, header, 'icao24')?.toUpperCase();
      if (!icao24) {
        continue;
      }
      next.set(icao24, {
        manufacturer: this.getColumn(cols, header, 'manufacturername'),
        model: this.getColumn(cols, header, 'model'),
        typeCode: this.getColumn(cols, header, 'typecode'),
        aircraftType: this.getColumn(cols, header, 'icaoaircrafttype'),
        categoryDescription: this.getColumn(cols, header, 'categoryDescription'),
        registration: this.getColumn(cols, header, 'registration'),
      });
    }
    this.aircraftDb = next;
    this.aircraftDbCount = next.size;
    this.logger.log(`Loaded ADS-B aircraft database (${this.aircraftDbCount} entries)`);
  }

  private async loadAirportsDatabaseFromDisk(path = this.airportsPath): Promise<void> {
    if (!path.startsWith(this.dataDir)) {
      throw new Error('Invalid airport database path');
    }
    if (!existsSync(path)) {
      return;
    }
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const byIcao = new Map<string, AirportInfo>();
    const byIata = new Map<string, AirportInfo>();
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = this.parseCsvLine(line);
      if (cols.length < 7) continue;
      const name = cols[1]?.replace(/^"+|"+$/g, '') ?? null;
      const city = cols[2]?.replace(/^"+|"+$/g, '') ?? null;
      const country = cols[3]?.replace(/^"+|"+$/g, '') ?? null;
      const iata = cols[4]?.trim().toUpperCase() || null;
      const icao = cols[5]?.trim().toUpperCase() || null;
      if (!icao && !iata) {
        continue;
      }
      const info: AirportInfo = { icao, iata, name, city, country };
      if (icao) byIcao.set(icao, info);
      if (iata) byIata.set(iata, info);
    }
    this.airportsByIcao = byIcao;
    this.airportsByIata = byIata;
    this.logger.log(`Loaded ADS-B airport database (${byIcao.size} ICAO entries)`);
  }

  private async loadConfigFromDisk(): Promise<void> {
    try {
      if (!existsSync(this.configPath)) {
        return;
      }
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<{
        enabled: boolean;
        feedUrl: string;
        intervalMs: number;
        geofencesEnabled: boolean;
        openskyEnabled: boolean;
        openskyClientId?: string | null;
        openskyClientSecret?: string | null;
      }>;
      if (typeof parsed.enabled === 'boolean') {
        this.enabled = this.hardDisabled ? false : parsed.enabled;
      }
      if (typeof parsed.feedUrl === 'string' && parsed.feedUrl.trim()) {
        this.feedUrl = parsed.feedUrl.trim();
      }
      if (typeof parsed.intervalMs === 'number' && Number.isFinite(parsed.intervalMs)) {
        this.intervalMs = Math.max(2000, parsed.intervalMs);
      }
      if (typeof parsed.geofencesEnabled === 'boolean') {
        this.geofencesEnabled = parsed.geofencesEnabled;
      }
      if (typeof parsed.openskyEnabled === 'boolean') {
        this.openskyEnabled = this.hardDisabled ? false : parsed.openskyEnabled;
      }
      if (typeof parsed.openskyClientId === 'string') {
        this.openskyClientId = parsed.openskyClientId.trim() || undefined;
      }
      if (typeof parsed.openskyClientSecret === 'string') {
        this.openskyClientSecret = parsed.openskyClientSecret.trim() || undefined;
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load ADS-B config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async persistConfig(): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const payload = {
        enabled: this.enabled,
        feedUrl: this.feedUrl,
        intervalMs: this.intervalMs,
        geofencesEnabled: this.geofencesEnabled,
        openskyEnabled: this.openskyEnabled,
        openskyClientId: this.openskyClientId ?? null,
        openskyClientSecret: this.openskyClientSecret ?? null,
      };
      await writeFile(this.configPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      this.logger.warn(
        `Failed to persist ADS-B config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  private getColumn(cols: string[], header: string[], name: string): string | null {
    const idx = header.findIndex((col) => col.toLowerCase() === name.toLowerCase());
    if (idx === -1) {
      return null;
    }
    const value = cols[idx]?.trim();
    return value && value.length > 0 ? value : null;
  }

  private startPolling(): void {
    this.timer = setIntervalSafe(() => {
      void this.poll().catch((error) => {
        this.lastError = this.normalizeError(error);
        this.logger.warn(`ADSB poll failed: ${this.lastError}`);
      });
    }, this.intervalMs);
    void this.poll().catch((error) => {
      this.lastError = this.normalizeError(error);
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
    if (!this.enabled) {
      return; // ignore scheduled polls when ADS-B is disabled
    }
    if (!this.feedUrl) {
      throw new Error('No ADSB feed URL configured');
    }
    const feedUrl = validateFeedUrl(this.feedUrl);
    // codeql[js/request-forgery] Admin-configured URL with protocol validation
    const response = await fetch(feedUrl, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        validateFeedUrl(new URL(location, feedUrl).toString());
      }
      throw new Error('Redirect not followed - update feed URL directly');
    }
    if (!response.ok) {
      throw new Error(`ADSB feed error: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { aircraft?: Dump1090Aircraft[] };
    const aircraft = Array.isArray(payload.aircraft) ? payload.aircraft : [];
    const nextTracks: Map<string, AdsbTrack> = new Map();
    const enrichTasks: Promise<void>[] = [];

    aircraft.forEach((entry) => {
      if (typeof entry.lat !== 'number' || typeof entry.lon !== 'number') {
        return;
      }
      const hex = (entry.hex ?? '').trim().toUpperCase();
      if (!hex) {
        return;
      }
      const id = hex;
      const existing = this.tracks.get(id);
      const callsign = (entry.flight ?? '').trim() || null;
      const alt = entry.alt_geom ?? entry.alt_baro ?? null;
      const now = new Date(Date.now() - (entry.seen ?? 0) * 1000).toISOString();
      const { dep, dest } = this.extractRoute(entry, existing);
      const track: AdsbTrack = {
        id,
        icao: hex,
        callsign,
        reg:
          typeof entry.reg === 'string' && entry.reg.trim()
            ? entry.reg.trim()
            : typeof entry.r === 'string' && entry.r.trim()
              ? entry.r.trim()
              : typeof entry.reg_num === 'string' && entry.reg_num.trim()
                ? entry.reg_num.trim()
                : (existing?.reg ?? null),
        lat: entry.lat,
        lon: entry.lon,
        alt: typeof alt === 'number' ? alt : (existing?.alt ?? null),
        speed: typeof entry.gs === 'number' ? entry.gs : (existing?.speed ?? null),
        heading: typeof entry.track === 'number' ? entry.track : (existing?.heading ?? null),
        onGround: null,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
        siteId: this.localSiteId,
        category:
          typeof entry.category === 'string'
            ? entry.category.trim() || null
            : (existing?.category ?? null),
        dep,
        dest,
        depTime: existing?.depTime ?? null,
        destTime: existing?.destTime ?? null,
        depDistanceM: existing?.depDistanceM ?? null,
        destDistanceM: existing?.destDistanceM ?? null,
        depCandidates: existing?.depCandidates ?? null,
        destCandidates: existing?.destCandidates ?? null,
        routeSource: dep || dest ? 'feed' : (existing?.routeSource ?? null),
        country:
          typeof entry.cntry === 'string' && entry.cntry.trim()
            ? entry.cntry.trim()
            : typeof entry.country === 'string' && entry.country.trim()
              ? entry.country.trim()
              : (existing?.country ?? null),
        messages:
          typeof entry.messages === 'number' ? entry.messages : (existing?.messages ?? null),
      };
      this.enrichAirportMetadata(track);
      this.enrichTrack(track);
      nextTracks.set(id, track);

      if (this.openskyEnabled && (!track.dep || !track.dest)) {
        enrichTasks.push(this.enrichRoute(track));
      }
      if (this.planespottersEnabled) {
        enrichTasks.push(this.enrichPhoto(track));
      }
    });

    // Update current active tracks (for map)
    this.tracks = nextTracks;

    // Merge into session log (for ADS-B log page)
    nextTracks.forEach((track, id) => {
      this.sessionLog.set(id, track);
    });

    if (enrichTasks.length > 0) {
      await Promise.allSettled(enrichTasks);
    }

    this.lastPollAt = new Date().toISOString();
    this.lastError = null;
    this.evaluateGeofences(this.tracks);
    this.gateway.emitEvent(
      { type: 'adsb.tracks', tracks: Array.from(nextTracks.values()) },
      { skipBus: true },
    );
  }

  private async refreshGeofences(): Promise<void> {
    if (!this.geofencesEnabled) {
      this.geofences = [];
      this.geofenceStates.clear();
      return;
    }
    try {
      this.geofences = await this.geofencesService.list({ includeRemote: true });
      this.geofenceStates.clear();
    } catch (error) {
      this.logger.warn(
        `Failed to refresh geofences for ADS-B: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private handleGeofenceChange(event: GeofenceEvent): void {
    if (event.type === 'upsert') {
      this.upsertGeofenceLocal(event.geofence);
    } else if (event.type === 'delete' || event.type === 'delete-request') {
      this.removeGeofenceLocal(event.geofence.id);
    }
  }

  private upsertGeofenceLocal(geofence: GeofenceResponse): void {
    const existingIndex = this.geofences.findIndex((item) => item.id === geofence.id);
    if (existingIndex >= 0) {
      this.geofences[existingIndex] = geofence;
    } else {
      this.geofences.push(geofence);
    }
    this.geofenceStates.delete(geofence.id);
  }

  private removeGeofenceLocal(id: string): void {
    this.geofences = this.geofences.filter((geofence) => geofence.id !== id);
    this.geofenceStates.delete(id);
  }

  private evaluateGeofences(tracks: Map<string, AdsbTrack>): void {
    if (!this.geofencesEnabled || this.geofences.length === 0) {
      this.geofenceStates.clear();
      return;
    }

    const activeEntities = new Set<string>();
    tracks.forEach((track) => {
      const entityKey = this.buildEntityKey(track);
      activeEntities.add(entityKey);
      this.geofences.forEach((geofence) => {
        if (!geofence.alarm.enabled || geofence.polygon.length < 3 || !geofence.appliesToAdsb) {
          return;
        }
        const inside = this.pointInPolygon(track.lat, track.lon, geofence.polygon);
        const geofenceState = this.geofenceStates.get(geofence.id) ?? new Map<string, boolean>();
        const prevInside = geofenceState.get(entityKey) ?? false;
        geofenceState.set(entityKey, inside);
        this.geofenceStates.set(geofence.id, geofenceState);

        if (inside && !prevInside) {
          this.emitGeofenceAlert(geofence, track, 'enter');
        } else if (!inside && prevInside && geofence.alarm.triggerOnExit) {
          this.emitGeofenceAlert(geofence, track, 'exit');
        }
      });
    });

    this.geofenceStates.forEach((stateMap, geofenceId) => {
      Array.from(stateMap.keys()).forEach((key) => {
        if (!activeEntities.has(key)) {
          stateMap.delete(key);
        }
      });
      if (stateMap.size === 0) {
        this.geofenceStates.delete(geofenceId);
      }
    });
  }

  private emitGeofenceAlert(
    geofence: GeofenceResponse,
    track: AdsbTrack,
    transition: 'enter' | 'exit',
  ): void {
    const siteId = geofence.siteId ?? track.siteId ?? this.localSiteId;
    const label = track.callsign ?? track.icao;
    const message = this.formatGeofenceMessage(geofence.alarm.message, {
      geofence: geofence.name,
      entity: label,
      type: 'adsb',
      event: transition,
    });

    this.gateway.emitEvent({
      type: 'event.alert',
      category: 'geofence',
      level: (geofence.alarm.level as AlarmLevel) ?? 'NOTICE',
      geofenceId: geofence.id,
      geofenceName: geofence.name,
      nodeId: label,
      siteId,
      message,
      lat: track.lat,
      lon: track.lon,
      timestamp: new Date().toISOString(),
      data: {
        geofenceId: geofence.id,
        geofenceName: geofence.name,
        entityId: track.id,
        entityType: 'adsb',
        transition,
      },
    });
  }

  private buildEntityKey(track: AdsbTrack): string {
    const siteId = track.siteId ?? this.localSiteId;
    return `${siteId}::${track.id}`;
  }

  private enrichTrack(track: AdsbTrack): void {
    const entry = this.aircraftDb.get(track.icao.toUpperCase());
    if (!entry) {
      return;
    }
    track.manufacturer = entry.manufacturer ?? track.manufacturer ?? null;
    track.model = entry.model ?? track.model ?? null;
    track.typeCode = entry.typeCode ?? track.typeCode ?? null;
    track.aircraftType = entry.aircraftType ?? track.aircraftType ?? null;
    track.categoryDescription = entry.categoryDescription ?? track.categoryDescription ?? null;
    track.reg = entry.registration ?? track.reg ?? null;
    if (!track.category && entry.categoryDescription) {
      track.category = entry.categoryDescription;
    }
  }

  private pointInPolygon(lat: number, lon: number, polygon: GeofenceVertex[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lat;
      const yi = polygon[i].lon;
      const xj = polygon[j].lat;
      const yj = polygon[j].lon;
      const intersect =
        yi > lon !== yj > lon && lat < ((xj - xi) * (lon - yi)) / (yj - yi + Number.EPSILON) + xi;
      if (intersect) {
        inside = !inside;
      }
    }
    return inside;
  }

  private formatGeofenceMessage(
    template: string | undefined,
    context: { geofence: string; entity: string; type: string; event: 'enter' | 'exit' },
  ): string {
    const message =
      template && template.trim().length > 0
        ? template
        : `{entity} ${context.event}s geofence {geofence}`;
    return message
      .replace(/\{geofence\}/gi, context.geofence)
      .replace(/\{entity\}/gi, context.entity)
      .replace(/\{node\}/gi, context.entity)
      .replace(/\{type\}/gi, context.type)
      .replace(/\{event\}/gi, context.event);
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed/i.test(message)) {
      return 'Failed to fetch feed';
    }
    return message;
  }

  private async loadOpenskyCredentialsFromFile(): Promise<void> {
    if (this.openskyClientId && this.openskyClientSecret) {
      this.logger.debug('OpenSky credentials already provided via config.');
      return;
    }
    const candidates = [this.openskyCredentialsFile, join(process.cwd(), 'credentials.json')];
    try {
      for (const path of candidates) {
        if (!path || !existsSync(path)) {
          continue;
        }
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw) as {
          clientId?: string;
          clientSecret?: string;
          tokenUrl?: string;
        };
        if (!this.openskyClientId && parsed.clientId) {
          this.openskyClientId = parsed.clientId.trim();
        }
        if (!this.openskyClientSecret && parsed.clientSecret) {
          this.openskyClientSecret = parsed.clientSecret.trim();
        }
        if (parsed.tokenUrl && parsed.tokenUrl.trim()) {
          this.openskyTokenUrl = parsed.tokenUrl.trim();
        }
        if (this.openskyClientId || this.openskyClientSecret) {
          this.logger.log(`Loaded OpenSky credentials from ${path}`);
          return;
        }
      }
      this.logger.debug('No OpenSky credential file found among candidates.');
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async enrichRoute(track: AdsbTrack): Promise<void> {
    try {
      if (!this.openskyEnabled || !this.openskyClientId || !this.openskyClientSecret) {
        return;
      }

      const cached = this.routeCache.get(track.icao);
      const now = Date.now();
      if (cached && now - cached.ts < AdsbService.ROUTE_CACHE_TTL_MS) {
        if (cached.dep && !track.dep) track.dep = cached.dep;
        if (cached.dest && !track.dest) track.dest = cached.dest;
        this.syncTrackRoute(track);
        return;
      }

      const route = await this.fetchOpenSkyRoute(track.icao);
      if (!route) {
        return;
      }

      this.routeCache.set(track.icao, { dep: route.dep, dest: route.dest, ts: now });
      track.routeSource = 'opensky';
      if (route.dep && !track.dep) track.dep = route.dep;
      if (route.dest && !track.dest) track.dest = route.dest;
      if (route.depTime) track.depTime = route.depTime;
      if (route.destTime) track.destTime = route.destTime;
      if (route.depDistanceM !== undefined) track.depDistanceM = route.depDistanceM;
      if (route.destDistanceM !== undefined) track.destDistanceM = route.destDistanceM;
      if (route.depCandidates !== undefined) track.depCandidates = route.depCandidates;
      if (route.destCandidates !== undefined) track.destCandidates = route.destCandidates;
      this.enrichAirportMetadata(track);
      this.syncTrackRoute(track);
    } catch (error) {
      this.logger.debug(
        `OpenSky enrichment failed for ${track.icao}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async enrichPhoto(track: AdsbTrack): Promise<void> {
    const hex = track.icao?.toLowerCase();
    if (!hex) return;
    const now = Date.now();
    const cached = this.photoCache.get(hex);
    const cachedFresh = cached && now - cached.ts < AdsbService.PHOTO_CACHE_TTL_MS;
    const cachedHasImage = cached?.thumb || cached?.url;
    if (cachedFresh && cachedHasImage) {
      this.applyPhoto(track, cached);
      return;
    }

    try {
      const photo = await this.fetchPlanespottersPhoto(hex, track.reg ?? undefined);
      const record = {
        url: photo?.url ?? null,
        thumb: photo?.thumb ?? null,
        author: photo?.author ?? null,
        sourceUrl: photo?.sourceUrl ?? null,
        ts: now,
      };
      this.photoCache.set(hex, record);
      this.applyPhoto(track, record);
    } catch (error) {
      // Cache only the failure timestamp; allow retries so images can recover if API was temporarily unavailable.
      this.photoCache.set(hex, {
        url: null,
        thumb: null,
        author: null,
        sourceUrl: null,
        ts: now,
      });
      this.logger.debug(
        `Planespotters lookup failed for ${hex}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private syncTrackRoute(track: AdsbTrack): void {
    const current = this.tracks.get(track.id);
    if (current) {
      current.dep = track.dep ?? current.dep ?? null;
      current.dest = track.dest ?? current.dest ?? null;
      current.routeSource = track.routeSource ?? current.routeSource ?? null;
      current.depTime = track.depTime ?? current.depTime ?? null;
      current.destTime = track.destTime ?? current.destTime ?? null;
      current.depDistanceM = track.depDistanceM ?? current.depDistanceM ?? null;
      current.destDistanceM = track.destDistanceM ?? current.destDistanceM ?? null;
      current.depCandidates = track.depCandidates ?? current.depCandidates ?? null;
      current.destCandidates = track.destCandidates ?? current.destCandidates ?? null;
      current.depIata = track.depIata ?? current.depIata ?? null;
      current.destIata = track.destIata ?? current.destIata ?? null;
      current.depIcao = track.depIcao ?? current.depIcao ?? null;
      current.destIcao = track.destIcao ?? current.destIcao ?? null;
      current.depAirport = track.depAirport ?? current.depAirport ?? null;
      current.destAirport = track.destAirport ?? current.destAirport ?? null;
    }
    const log = this.sessionLog.get(track.id);
    if (log) {
      log.dep = track.dep ?? log.dep ?? null;
      log.dest = track.dest ?? log.dest ?? null;
      log.routeSource = track.routeSource ?? log.routeSource ?? null;
      log.depTime = track.depTime ?? log.depTime ?? null;
      log.destTime = track.destTime ?? log.destTime ?? null;
      log.depDistanceM = track.depDistanceM ?? log.depDistanceM ?? null;
      log.destDistanceM = track.destDistanceM ?? log.destDistanceM ?? null;
      log.depCandidates = track.depCandidates ?? log.depCandidates ?? null;
      log.destCandidates = track.destCandidates ?? log.destCandidates ?? null;
      log.depIata = track.depIata ?? log.depIata ?? null;
      log.destIata = track.destIata ?? log.destIata ?? null;
      log.depIcao = track.depIcao ?? log.depIcao ?? null;
      log.destIcao = track.destIcao ?? log.destIcao ?? null;
      log.depAirport = track.depAirport ?? log.depAirport ?? null;
      log.destAirport = track.destAirport ?? log.destAirport ?? null;
      this.sessionLog.set(track.id, log);
    }
  }

  private async fetchOpenSkyRoute(icao: string): Promise<{
    dep: string | null;
    dest: string | null;
    depTime?: string | null;
    destTime?: string | null;
    depDistanceM?: number | null;
    destDistanceM?: number | null;
    depCandidates?: number | null;
    destCandidates?: number | null;
  } | null> {
    const end = Math.floor(Date.now() / 1000);
    const begin = end - 12 * 3600;
    const url = `https://opensky-network.org/api/flights/aircraft?icao24=${icao.toLowerCase()}&begin=${begin}&end=${end}`;

    const response = await this.fetchWithOpenskyAuth(url);

    if (!response.ok) {
      throw new Error(`OpenSky ${response.status} ${response.statusText}`);
    }

    const flights = (await response.json()) as Array<{
      estDepartureAirport?: string | null;
      estArrivalAirport?: string | null;
      firstSeen?: number;
      lastSeen?: number;
      estDepartureAirportHorizDistance?: number;
      estArrivalAirportHorizDistance?: number;
      estDepartureAirportCandidatesCount?: number;
      estArrivalAirportCandidatesCount?: number;
    }>;
    if (!Array.isArray(flights) || flights.length === 0) {
      return null;
    }

    const latest = flights[flights.length - 1];
    const dep = typeof latest.estDepartureAirport === 'string' ? latest.estDepartureAirport : null;
    const dest = typeof latest.estArrivalAirport === 'string' ? latest.estArrivalAirport : null;
    if (!dep && !dest) {
      return null;
    }
    return {
      dep: dep ?? null,
      dest: dest ?? null,
      depTime: latest.firstSeen ? new Date(latest.firstSeen * 1000).toISOString() : null,
      destTime: latest.lastSeen ? new Date(latest.lastSeen * 1000).toISOString() : null,
      depDistanceM:
        typeof latest.estDepartureAirportHorizDistance === 'number'
          ? latest.estDepartureAirportHorizDistance
          : null,
      destDistanceM:
        typeof latest.estArrivalAirportHorizDistance === 'number'
          ? latest.estArrivalAirportHorizDistance
          : null,
      depCandidates:
        typeof latest.estDepartureAirportCandidatesCount === 'number'
          ? latest.estDepartureAirportCandidatesCount
          : null,
      destCandidates:
        typeof latest.estArrivalAirportCandidatesCount === 'number'
          ? latest.estArrivalAirportCandidatesCount
          : null,
    };
  }

  private async fetchWithOpenskyAuth(url: string, attempt = 0): Promise<Response> {
    const token = await this.getOpenskyAccessToken(attempt > 0);
    if (!token) {
      throw new Error('OpenSky credentials not configured');
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if ((response.status === 401 || response.status === 403) && attempt < 1) {
      this.openskyAccessToken = undefined;
      this.openskyTokenExpiryMs = 0;
      return this.fetchWithOpenskyAuth(url, attempt + 1);
    }

    return response;
  }

  private async getOpenskyAccessToken(forceRefresh = false): Promise<string | null> {
    if (!this.openskyClientId || !this.openskyClientSecret) {
      return null;
    }
    const now = Date.now();
    if (!forceRefresh && this.openskyAccessToken && now < this.openskyTokenExpiryMs) {
      return this.openskyAccessToken;
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', this.openskyClientId);
    body.set('client_secret', this.openskyClientSecret);

    const response = await fetch(this.openskyTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`OpenSky auth failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new Error('OpenSky auth response missing access_token');
    }

    const ttlMs = typeof payload.expires_in === 'number' ? payload.expires_in * 1000 : 300_000;
    this.openskyAccessToken = payload.access_token;
    this.openskyTokenExpiryMs = Date.now() + Math.max(30_000, ttlMs - 30_000);
    return this.openskyAccessToken;
  }

  private extractRoute(
    entry: Dump1090Aircraft,
    existing?: AdsbTrack,
  ): { dep: string | null; dest: string | null } {
    const candidates = [
      typeof entry.dep === 'string' ? entry.dep.trim() : null,
      typeof entry.dest === 'string' ? entry.dest.trim() : null,
    ];

    const departure =
      candidates[0] && candidates[0].length > 0 ? candidates[0] : (existing?.dep ?? null);
    const destination =
      candidates[1] && candidates[1].length > 0 ? candidates[1] : (existing?.dest ?? null);

    if (departure && destination) {
      return { dep: departure, dest: destination };
    }

    const estDep =
      typeof (entry as Record<string, unknown>).estDepartureAirport === 'string'
        ? ((entry as Record<string, unknown>).estDepartureAirport as string).trim()
        : null;
    const estArr =
      typeof (entry as Record<string, unknown>).estArrivalAirport === 'string'
        ? ((entry as Record<string, unknown>).estArrivalAirport as string).trim()
        : null;

    const fromField =
      typeof (entry as Record<string, unknown>).from === 'string'
        ? ((entry as Record<string, unknown>).from as string).trim()
        : null;
    const toField =
      typeof (entry as Record<string, unknown>).to === 'string'
        ? ((entry as Record<string, unknown>).to as string).trim()
        : null;

    const route = typeof entry.r === 'string' ? entry.r.trim() : null;
    let routeDep: string | null = null;
    let routeDest: string | null = null;
    if (route && route.length >= 6) {
      if (route.includes(' ') || route.includes('-') || route.includes('/')) {
        const parts = route.split(/[\s/-]+/).filter((p) => p.length > 0);
        if (parts.length >= 2) {
          routeDep = parts[0];
          routeDest = parts[1];
        }
      } else if (route.length === 6) {
        routeDep = route.slice(0, 3);
        routeDest = route.slice(3, 6);
      }
    }

    return {
      dep: departure ?? fromField ?? estDep ?? routeDep ?? existing?.dep ?? null,
      dest: destination ?? toField ?? estArr ?? routeDest ?? existing?.dest ?? null,
    };
  }

  private enrichAirportMetadata(track: AdsbTrack): void {
    const depInfo = this.resolveAirport(track.dep);
    const destInfo = this.resolveAirport(track.dest);

    if (depInfo) {
      track.depIcao =
        depInfo.icao ?? track.depIcao ?? (track.dep && track.dep.length === 4 ? track.dep : null);
      track.depIata =
        depInfo.iata ?? track.depIata ?? (track.dep && track.dep.length === 3 ? track.dep : null);
      track.depAirport = depInfo.name ?? track.depAirport ?? depInfo.city ?? null;
      if (depInfo.icao && track.dep && track.dep.length === 3) {
        track.dep = depInfo.icao;
      }
    }

    if (destInfo) {
      track.destIcao =
        destInfo.icao ??
        track.destIcao ??
        (track.dest && track.dest.length === 4 ? track.dest : null);
      track.destIata =
        destInfo.iata ??
        track.destIata ??
        (track.dest && track.dest.length === 3 ? track.dest : null);
      track.destAirport = destInfo.name ?? track.destAirport ?? destInfo.city ?? null;
      if (destInfo.icao && track.dest && track.dest.length === 3) {
        track.dest = destInfo.icao;
      }
    }
  }

  private resolveAirport(code?: string | null): AirportInfo | null {
    if (!code) return null;
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return null;
    const fromIcao = this.airportsByIcao.get(trimmed);
    if (fromIcao) return fromIcao;
    const fromIata = this.airportsByIata.get(trimmed);
    if (fromIata) return fromIata;
    return null;
  }

  private applyPhoto(
    track: AdsbTrack,
    photo: {
      url: string | null;
      thumb: string | null;
      author: string | null;
      sourceUrl: string | null;
    },
  ): void {
    track.photoUrl = photo.url ?? track.photoUrl ?? null;
    track.photoThumbUrl = photo.thumb ?? track.photoThumbUrl ?? null;
    track.photoAuthor = photo.author ?? track.photoAuthor ?? null;
    track.photoSourceUrl = photo.sourceUrl ?? track.photoSourceUrl ?? null;
    this.syncTrackRoute(track);
  }

  private async fetchPlanespottersPhoto(
    hex: string,
    _registration?: string | null,
  ): Promise<{
    url: string | null;
    thumb: string | null;
    author: string | null;
    sourceUrl: string | null;
  } | null> {
    const targetHex = hex.toLowerCase();
    const url = `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(targetHex)}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Planespotters ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as {
      photos?: Array<{
        thumbnail?: { src?: string };
        thumbnail_large?: { src?: string };
        large?: { src?: string };
        link?: string;
        photographer?: string;
      }>;
    };
    const photo =
      Array.isArray(payload.photos) && payload.photos.length > 0 ? payload.photos[0] : null;
    if (!photo) {
      return null;
    }
    return {
      url: photo.large?.src ?? photo.thumbnail_large?.src ?? photo.thumbnail?.src ?? null,
      thumb:
        photo.thumbnail?.src ??
        photo.thumbnail_large?.src ??
        photo.large?.src ??
        photo.link ??
        null,
      author: photo.photographer ?? null,
      sourceUrl: photo.link ?? null,
    };
  }
}
