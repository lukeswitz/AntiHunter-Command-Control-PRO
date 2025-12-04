import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { setTimeout as delay } from 'node:timers/promises';

import { FaaAircraftSummary } from './faa.types';
import { PrismaService } from '../prisma/prisma.service';

const FAA_DATASET_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';
const MASTER_FILE_NAME = 'MASTER.txt';

const FAA_ONLINE_BASE_URL = 'https://uasdoc.faa.gov';
const FAA_ONLINE_HOME_PATH = '/listdocs';
const FAA_ONLINE_API_PATH = '/api/v1/serialNumbers';

type LookupKey = { kind: 'modeS'; value: string } | { kind: 'nNumber'; value: string };

interface FaaOnlineResponse {
  data?: {
    items?: Record<string, unknown>[];
    formattedItems?: Record<string, unknown>[];
  };
}

@Injectable()
export class FaaRegistryService {
  private readonly logger = new Logger(FaaRegistryService.name);
  private currentSync: Promise<void> | null = null;
  private progress: { processed: number; startedAt: Date } | null = null;
  private lastError: string | null = null;
  private readonly summaryCache = new Map<string, FaaAircraftSummary | null>();

  private readonly onlineLookupEnabled: boolean;
  private readonly onlineCacheTtlMs: number;
  private readonly onlineCache = new Map<
    string,
    { summary: FaaAircraftSummary | null; expiresAt: number }
  >();
  private onlineCookie?: string;
  private onlineCookieFetchedAt = 0;
  private readonly onlineCookieTtlMs = 10 * 60 * 1000; // 10 minutes
  private readonly onlineLookupCooldownMs: number;
  private readonly onlineCooldowns = new Map<string, number>();

  private readonly onlineHeaders = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:137.0) Gecko/20100101 Firefox/137.0',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.5',
    Referer: `${FAA_ONLINE_BASE_URL}${FAA_ONLINE_HOME_PATH}`,
    client: 'external',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.onlineLookupEnabled = this.configService.get<boolean>('faa.onlineLookupEnabled', true);
    const ttlMinutes = this.configService.get<number>('faa.onlineCacheTtlMinutes', 60) ?? 60;
    this.onlineCacheTtlMs = ttlMinutes * 60 * 1000;
    const cooldownMinutes =
      this.configService.get<number>('faa.onlineLookupCooldownMinutes', 10) ?? 10;
    this.onlineLookupCooldownMs = Math.max(1, cooldownMinutes) * 60 * 1000;
  }

  async getStatus() {
    const registry = await this.ensureRegistryRecord();
    const totalRecords = await this.faaModel().count();
    return {
      registry: { ...registry, totalRecords },
      inProgress: this.currentSync !== null,
      progress: this.progress,
      lastError: this.lastError,
      online: {
        enabled: this.onlineLookupEnabled,
        cacheEntries: this.onlineCache.size,
      },
    };
  }

  async triggerSync(datasetUrl?: string) {
    if (this.currentSync) {
      throw new BadRequestException('FAA registry sync already running');
    }
    const targetUrl = (datasetUrl ?? FAA_DATASET_URL).trim() || FAA_DATASET_URL;

    // Validate URL to prevent SSRF attacks
    this.validateDatasetUrl(targetUrl);

    this.logger.log(`Starting FAA registry sync from ${targetUrl}`);
    this.progress = { processed: 0, startedAt: new Date() };
    this.lastError = null;
    this.currentSync = this.performSync(targetUrl)
      .then(() => {
        this.logger.log('FAA registry sync completed');
      })
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger.error(`FAA registry sync failed: ${this.lastError}`);
      })
      .finally(() => {
        this.currentSync = null;
        this.progress = null;
      });

    return { started: true };
  }

  async lookupAircraft(
    droneId?: string | null,
    mac?: string | null,
  ): Promise<FaaAircraftSummary | null> {
    const trimmedId = typeof droneId === 'string' ? droneId.trim() : null;
    const normalizedId = trimmedId ? trimmedId.toUpperCase() : null;

    if (this.onlineLookupEnabled && trimmedId) {
      for (const candidate of this.buildOnlineIdCandidates(trimmedId)) {
        const cacheKey = this.normalizeOnlineKey(candidate);
        const cached = this.onlineCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.summary;
        }
        if (this.isOnlineLookupThrottled(cacheKey)) {
          continue;
        }
        const onlineResult = await this.lookupOnline(candidate, cacheKey);
        if (onlineResult) {
          return onlineResult;
        }
      }
    }

    const keys = this.buildLookupKeys(normalizedId, mac);
    if (keys.length === 0) {
      return null;
    }

    for (const key of keys) {
      const cacheKey = `${key.kind}:${key.value}`;
      if (this.summaryCache.has(cacheKey)) {
        const cached = this.summaryCache.get(cacheKey) ?? null;
        if (cached) {
          return cached;
        }
        continue;
      }

      const record =
        key.kind === 'modeS'
          ? await this.faaModel().findFirst({ where: { modeSCodeHex: key.value } })
          : await this.faaModel().findFirst({ where: { nNumber: key.value } });
      if (record) {
        const summary = this.mapSummary(record);
        this.summaryCache.set(cacheKey, summary);
        return summary;
      }
      this.summaryCache.set(cacheKey, null);
    }

    return null;
  }

  private async lookupOnline(
    droneId: string,
    cacheKey: string,
  ): Promise<FaaAircraftSummary | null> {
    this.onlineCooldowns.set(cacheKey, Date.now());

    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.ensureOnlineCookie(attempt > 0);
        const url = new URL(FAA_ONLINE_API_PATH, FAA_ONLINE_BASE_URL);
        url.searchParams.set('itemsPerPage', '8');
        url.searchParams.set('pageIndex', '0');
        url.searchParams.set('orderBy[0]', 'updatedAt');
        url.searchParams.set('orderBy[1]', 'DESC');
        url.searchParams.set('findBy', 'serialNumber');
        url.searchParams.set('serialNumber', droneId);

        const response = await fetch(url, {
          headers: {
            ...this.onlineHeaders,
            Cookie: this.onlineCookie ?? '',
          },
        });

        if (response.status === 502) {
          this.logger.debug('FAA lookup returned 502, retrying…');
          await delay((attempt + 1) * 1000).catch(() => undefined);
          continue;
        }

        if (!response.ok) {
          throw new Error(`FAA lookup failed with status ${response.status}`);
        }

        const payload = (await response.json()) as FaaOnlineResponse;
        const record = this.extractOnlineRecord(payload);
        const summary = record ? this.mapOnlineRecord(record, droneId) : null;
        this.onlineCache.set(cacheKey, {
          summary,
          expiresAt: Date.now() + this.onlineCacheTtlMs,
        });
        return summary;
      } catch (error) {
        this.logger.debug(
          `Online FAA lookup attempt ${attempt + 1} failed: ${
            error instanceof Error ? error.message : error
          }`,
        );
        await delay((attempt + 1) * 1000).catch(() => undefined);
      }
    }

    return null;
  }

  private async ensureOnlineCookie(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.onlineCookie && now - this.onlineCookieFetchedAt < this.onlineCookieTtlMs) {
      return;
    }

    const url = new URL(FAA_ONLINE_HOME_PATH, FAA_ONLINE_BASE_URL);
    const response = await fetch(url, {
      headers: this.onlineHeaders,
    });
    if (!response.ok) {
      throw new Error(`FAA cookie refresh failed with status ${response.status}`);
    }
    const cookies =
      response.headers
        .getSetCookie?.()
        .map((entry) => entry.split(';')[0])
        .filter(Boolean) ?? [];
    if (!cookies.length) {
      throw new Error('FAA cookie refresh returned no cookies');
    }
    this.onlineCookie = cookies.join('; ');
    this.onlineCookieFetchedAt = now;
  }

  private extractOnlineRecord(response: FaaOnlineResponse): Record<string, unknown> | null {
    if (Array.isArray(response?.data?.items) && response.data.items.length > 0) {
      return response.data.items[0];
    }
    if (Array.isArray(response?.data?.formattedItems) && response.data.formattedItems.length > 0) {
      return response.data.formattedItems[0];
    }
    return null;
  }

  private mapOnlineRecord(
    record: Record<string, unknown>,
    fallbackId: string,
  ): FaaAircraftSummary | null {
    const serialNumber =
      this.extractString(record, ['serialNumber', 'serialNum', 'serial']) ?? fallbackId;
    const nNumber =
      this.extractString(record, ['nNumber', 'registrationNumber']) ?? serialNumber ?? fallbackId;
    if (!nNumber) {
      return null;
    }

    const documentNumber =
      this.extractString(record, [
        'documentNumber',
        'documentId',
        'docNumber',
        'trackingNumber',
        'trackingId',
        'rid',
        'ridNumber',
        'ridId',
      ]) ?? null;
    const normalizedDocument = documentNumber ? documentNumber.toUpperCase() : null;
    const trackingNumber =
      this.extractString(record, ['trackingNumber', 'trackingNumberDisplay']) ??
      normalizedDocument ??
      null;

    return {
      nNumber: nNumber.toUpperCase(),
      serialNumber: serialNumber?.toUpperCase() ?? null,
      documentNumber: normalizedDocument,
      documentUrl: normalizedDocument
        ? `${FAA_ONLINE_BASE_URL}/listDocs/${normalizedDocument}`
        : null,
      trackingNumber: trackingNumber ?? null,
      makeName: this.extractString(record, ['makeName', 'make']),
      modelName: this.extractString(record, ['modelName', 'model']),
      series: this.extractString(record, ['series']),
      fccIdentifier: this.extractString(record, ['fccIdentifier', 'fccId']),
      registrantName: this.extractString(record, ['name', 'operatorName', 'ownerName']),
      street1: this.extractString(record, ['address1', 'street1', 'street']),
      street2: this.extractString(record, ['address2', 'street2']),
      city: this.extractString(record, ['city']),
      state: this.extractString(record, ['state']),
      country: this.extractString(record, ['country']),
      aircraftType: this.extractString(record, ['aircraftType', 'type']),
      engineType: this.extractString(record, ['engineType']),
      statusCode: this.extractString(record, ['status', 'statusCode']),
      modeSCodeHex:
        this.extractString(record, ['modeSCodeHex', 'modeSCode', 'modeS'])?.toUpperCase() ?? null,
      yearManufactured: this.extractNumber(record, ['yearManufactured', 'year']),
      lastActionDate: this.extractDate(record, ['updatedAt', 'lastActionDate']),
      expirationDate: this.extractDate(record, ['expirationDate']),
    };
  }

  private extractString(record: Record<string, unknown>, fields: string[]): string | null {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return null;
  }

  private extractNumber(record: Record<string, unknown>, fields: string[]): number | null {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return null;
  }

  private extractDate(record: Record<string, unknown>, fields: string[]): Date | null {
    for (const field of fields) {
      const value = record[field];
      if (typeof value === 'string') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) {
          return date;
        }
      }
    }
    return null;
  }

  private buildLookupKeys(droneId?: string | null, mac?: string | null): LookupKey[] {
    const keys: LookupKey[] = [];
    if (droneId) {
      const normalized = droneId.trim().toUpperCase();
      if (normalized) {
        if (/^[0-9A-F]{6}$/.test(normalized)) {
          keys.push({ kind: 'modeS', value: normalized });
        }
        if (/^N[A-Z0-9]{1,5}[A-Z0-9]*$/.test(normalized)) {
          keys.push({ kind: 'nNumber', value: normalized });
        }
      }
    }

    if (mac) {
      const normalizedMac = mac.replace(/[^A-F0-9]/gi, '').toUpperCase();
      if (normalizedMac.length >= 6) {
        keys.push({ kind: 'modeS', value: normalizedMac.slice(-6) });
      }
    }

    return keys;
  }

  private buildOnlineIdCandidates(droneId: string): string[] {
    const trimmed = droneId.trim();
    if (!trimmed) {
      return [];
    }
    const candidates = new Set<string>();
    const lower = trimmed.toLowerCase();
    const upper = trimmed.toUpperCase();

    candidates.add(trimmed);
    candidates.add(lower);
    candidates.add(upper);

    if (!lower.startsWith('drone-')) {
      candidates.add(`drone-${lower}`);
      candidates.add(`DRONE-${upper}`);
    } else {
      const withoutPrefix = trimmed.replace(/^drone-/i, '');
      if (withoutPrefix) {
        candidates.add(withoutPrefix);
        candidates.add(withoutPrefix.toLowerCase());
        candidates.add(withoutPrefix.toUpperCase());
      }
    }

    return Array.from(candidates);
  }

  private normalizeOnlineKey(id: string): string {
    return id.trim().toUpperCase();
  }

  private isOnlineLookupThrottled(key: string): boolean {
    const last = this.onlineCooldowns.get(key);
    if (!last) {
      return false;
    }
    return Date.now() - last < this.onlineLookupCooldownMs;
  }

  private async performSync(datasetUrl: string): Promise<void> {
    const tempDir = await fs.mkdtemp(join(tmpdir(), 'faa-registry-'));
    const zipPath = join(tempDir, basename(datasetUrl) || 'faa.zip');
    try {
      await this.downloadFile(datasetUrl, zipPath);
      const zip = new AdmZip(zipPath);
      const masterEntry = zip.getEntry(MASTER_FILE_NAME);
      if (!masterEntry) {
        throw new Error(`Could not find ${MASTER_FILE_NAME} in downloaded archive`);
      }
      zip.extractEntryTo(masterEntry, tempDir, false, true);
      const masterPath = join(tempDir, MASTER_FILE_NAME);
      const datasetVersion = masterEntry.header?.time?.toISOString() ?? new Date().toISOString();
      await this.ingestMaster(masterPath, datasetUrl, datasetVersion);
      this.summaryCache.clear();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async downloadFile(url: string, destination: string): Promise<void> {
    this.validateDatasetUrl(url);
    const response = await fetch(url, {
      redirect: 'error',
    });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download FAA registry: ${response.status} ${response.statusText}`);
    }
    const webStream = response.body as unknown as WebReadableStream<Uint8Array>;
    const nodeStream = Readable.fromWeb(webStream);
    await pipeline(nodeStream, createWriteStream(destination));
  }

  private async ingestMaster(
    filePath: string,
    datasetUrl: string,
    datasetVersion: string,
  ): Promise<void> {
    const fileStream = createReadStream(filePath);
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: false,
    });
    const batchingSize = 1000;
    let batch: Record<string, unknown>[] = [];
    let total = 0;

    fileStream.pipe(parser);

    await this.prisma.$transaction(
      async (tx) => {
        await tx.faaAircraft.deleteMany();
        for await (const record of parser) {
          const mapped = this.mapRecord(record);
          if (!mapped) {
            continue;
          }
          batch.push(mapped);
          if (batch.length >= batchingSize) {
            await tx.faaAircraft.createMany({ data: batch as Prisma.FaaAircraftCreateManyInput[] });
            total += batch.length;
            batch = [];
            this.progress = this.progress ? { ...this.progress, processed: total } : null;
          }
        }
        if (batch.length > 0) {
          await tx.faaAircraft.createMany({ data: batch as Prisma.FaaAircraftCreateManyInput[] });
          total += batch.length;
          this.progress = this.progress ? { ...this.progress, processed: total } : null;
        }

        await tx.faaRegistrySync.upsert({
          where: { id: 1 },
          create: {
            id: 1,
            datasetUrl,
            datasetVersion,
            lastSyncedAt: new Date(),
            totalRecords: total,
          },
          update: {
            datasetUrl,
            datasetVersion,
            lastSyncedAt: new Date(),
            totalRecords: total,
          },
        });
      },
      {
        timeout: 120_000, // FAA ingest can take time; allow longer interactive transaction
      },
    );
  }

  private mapRecord(record: Record<string, string>): Prisma.FaaAircraftCreateManyInput | null {
    const normalizedRecord: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      const safeValue = typeof value === 'string' ? value : '';
      const normalizedKey = key.replace('\ufeff', '').trim();
      normalizedRecord[normalizedKey] = safeValue;
    }

    const pickField = (key: string) => normalizedRecord[key] ?? '';

    const nNumber = pickField('N-NUMBER').trim().toUpperCase();
    if (!nNumber) {
      return null;
    }

    const mapDate = (value?: string | null): Date | null => {
      const trimmed = (value ?? '').trim();
      if (!trimmed) {
        return null;
      }
      if (!/^\d{8}$/.test(trimmed)) {
        return null;
      }
      const year = Number(trimmed.slice(0, 4));
      const month = Number(trimmed.slice(4, 6)) - 1;
      const day = Number(trimmed.slice(6, 8));
      const date = new Date(Date.UTC(year, month, day));
      return Number.isNaN(date.getTime()) ? null : date;
    };

    const parseIntField = (value?: string | null): number | null => {
      const trimmed = (value ?? '').trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const fractionalOwner = pickField('FRACT OWNER').trim().toUpperCase();

    return {
      nNumber,
      serialNumber: pickField('SERIAL NUMBER').trim() || null,
      manufacturerModel: pickField('MFR MDL CODE').trim() || null,
      engineModel: pickField('ENG MFR MDL').trim() || null,
      yearManufactured: parseIntField(pickField('YEAR MFR')),
      registrantType: parseIntField(pickField('TYPE REGISTRANT')),
      registrantName: pickField('NAME').trim() || null,
      street1: pickField('STREET').trim() || null,
      street2: pickField('STREET2').trim() || null,
      city: pickField('CITY').trim() || null,
      state: pickField('STATE').trim() || null,
      zip: pickField('ZIP CODE').trim() || null,
      region: pickField('REGION').trim() || null,
      county: pickField('COUNTY').trim() || null,
      country: pickField('COUNTRY').trim() || null,
      lastActionDate: mapDate(pickField('LAST ACTION DATE')),
      certIssueDate: mapDate(pickField('CERT ISSUE DATE')),
      certification: pickField('CERTIFICATION').trim() || null,
      aircraftType: pickField('TYPE AIRCRAFT').trim() || null,
      engineType: pickField('TYPE ENGINE').trim() || null,
      statusCode: pickField('STATUS CODE').trim() || null,
      modeSCode: pickField('MODE S CODE').trim() || null,
      modeSCodeHex: pickField('MODE S CODE HEX').trim().toUpperCase() || null,
      fractionalOwner: fractionalOwner === 'Y',
      airworthinessDate: mapDate(pickField('AIR WORTH DATE')),
      expirationDate: mapDate(pickField('EXPIRATION DATE')),
      uniqueId: pickField('UNIQUE ID').trim() || null,
      kitManufacturer: pickField('KIT MFR').trim() || null,
      kitModel: pickField('KIT MODEL').trim() || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private mapSummary(record: Prisma.FaaAircraftCreateManyInput): FaaAircraftSummary {
    return {
      nNumber: String(record.nNumber),
      serialNumber: null,
      documentNumber: null,
      documentUrl: null,
      trackingNumber: null,
      makeName: null,
      modelName: null,
      series: null,
      fccIdentifier: null,
      registrantName: record.registrantName ?? null,
      street1: record.street1 ?? null,
      street2: record.street2 ?? null,
      city: record.city ?? null,
      state: record.state ?? null,
      country: record.country ?? null,
      aircraftType: record.aircraftType ?? null,
      engineType: record.engineType ?? null,
      statusCode: record.statusCode ?? null,
      modeSCodeHex: record.modeSCodeHex ?? null,
      yearManufactured: record.yearManufactured ?? null,
      lastActionDate: record.lastActionDate instanceof Date ? record.lastActionDate : null,
      expirationDate: record.expirationDate instanceof Date ? record.expirationDate : null,
    };
  }

  private async ensureRegistryRecord() {
    const existing = await this.faaRegistryModel().findUnique({ where: { id: 1 } });
    if (existing) {
      return existing;
    }
    return this.faaRegistryModel().create({
      data: { id: 1, totalRecords: 0 },
    });
  }

  private faaModel() {
    return this.prisma.faaAircraft;
  }

  private faaRegistryModel() {
    return this.prisma.faaRegistrySync;
  }

  private validateDatasetUrl(urlString: string): void {
    try {
      const url = new URL(urlString);

      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Dataset URL must use HTTP or HTTPS protocol');
      }

      const hostname = url.hostname.toLowerCase();

      if (
        hostname.includes('metadata') ||
        hostname === '169.254.169.254' ||
        hostname === 'metadata.google.internal' ||
        hostname.endsWith('.metadata.google.internal') ||
        hostname === 'fd00:ec2::254' ||
        hostname.startsWith('169.254.') ||
        hostname === '100.100.100.200'
      ) {
        throw new Error('Dataset URL cannot point to metadata endpoints');
      }

      const isLocalOrPrivate =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.startsWith('127.') ||
        hostname.startsWith('0.') ||
        hostname.startsWith('10.') ||
        (hostname.startsWith('172.') &&
          parseInt(hostname.split('.')[1], 10) >= 16 &&
          parseInt(hostname.split('.')[1], 10) <= 31) ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('fc') ||
        hostname.startsWith('fd') ||
        hostname.startsWith('fe80:');

      if (isLocalOrPrivate) {
        this.logger.warn(
          `Dataset URL ${urlString} points to local/private address. Allowed for development/testing.`,
        );
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error('Dataset URL is not valid');
      }
      throw error;
    }
  }
}
