import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  isImage,
  isTileInRange,
  MAX_PRELOAD_RADIUS_KM,
  MAX_PRELOAD_TILES,
  MAX_PRELOAD_ZOOM,
  signTileKey,
  TILE_PROVIDERS,
  TileProvider,
  tilesInRadius,
  upstreamUrl,
  verifyTileKey,
} from './tiles.util';
import { loadJwtSecret } from '../auth/jwt-secret';

const USER_AGENT =
  'AntiHunter-Command-Center (+https://github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO)';
const REFRESH_AFTER_MS = 30 * 86_400_000;
const OFFLINE_BACKOFF_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_FETCHES = 2;
const PRELOAD_DELAY_MS = 250;

export interface TileResult {
  data: Buffer;
  contentType: string;
  source: 'HIT' | 'MISS' | 'STALE';
}

export interface PreloadRequest {
  provider: string;
  lat: number;
  lng: number;
  radiusKm: number;
  minZoom: number;
  maxZoom: number;
}

export interface PreloadState {
  active: boolean;
  provider: string | null;
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
}

@Injectable()
export class TilesService {
  private readonly logger = new Logger(TilesService.name);
  private readonly secret = loadJwtSecret();
  private readonly cacheDir =
    process.env.AHCC_TILE_CACHE?.trim() || join(process.cwd(), 'data', 'tiles');
  private readonly maxBytes =
    Math.max(1, Number(process.env.AHCC_TILE_CACHE_MAX_MB) || 2048) * 1024 * 1024;
  private offlineUntil = 0;
  private activeFetches = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly inflight = new Map<string, Promise<Buffer | null>>();
  private cacheBytes: number | null = null;
  private pruning = false;
  private preloadAbort: AbortController | null = null;
  private preload: PreloadState = {
    active: false,
    provider: null,
    total: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    startedAt: null,
    finishedAt: null,
  };

  issueKey(userId: string): string {
    return signTileKey(this.secret, userId);
  }

  isKeyValid(key: string | undefined): boolean {
    return verifyTileKey(this.secret, key);
  }

  providers() {
    return Object.values(TILE_PROVIDERS).map(({ id, maxZoom, preload }) => ({
      id,
      maxZoom,
      preload,
    }));
  }

  isOnline(): boolean {
    return Date.now() >= this.offlineUntil;
  }

  async cacheStats() {
    return { bytes: await this.totalBytes(), maxBytes: this.maxBytes };
  }

  preloadState(): PreloadState {
    return { ...this.preload };
  }

  async getTile(providerId: string, z: number, x: number, y: number): Promise<TileResult | null> {
    const provider = TILE_PROVIDERS[providerId];
    if (!provider || !isTileInRange(provider, z, x, y)) {
      throw new BadRequestException('Unknown map source or tile out of range');
    }
    const contentType = provider.imageType === 'jpeg' ? 'image/jpeg' : 'image/png';
    const path = this.tilePath(provider, z, x, y);
    const cached = await this.readCached(provider, path);
    if (cached && (cached.ageMs < REFRESH_AFTER_MS || !this.isOnline())) {
      return { data: cached.data, contentType, source: 'HIT' };
    }
    if (this.isOnline()) {
      const fresh = await this.fetchOnce(provider, z, x, y, path);
      if (fresh) {
        return { data: fresh, contentType, source: 'MISS' };
      }
    }
    return cached ? { data: cached.data, contentType, source: 'STALE' } : null;
  }

  startPreload(request: PreloadRequest): { total: number } {
    const provider = TILE_PROVIDERS[request.provider];
    if (!provider) {
      throw new BadRequestException('Unknown map source');
    }
    if (!provider.preload) {
      throw new BadRequestException('This map source does not allow offline download');
    }
    const maxZoom = Math.min(MAX_PRELOAD_ZOOM, provider.maxZoom);
    if (
      request.radiusKm <= 0 ||
      request.radiusKm > MAX_PRELOAD_RADIUS_KM ||
      request.minZoom < 0 ||
      request.maxZoom < request.minZoom ||
      request.maxZoom > maxZoom ||
      Math.abs(request.lat) > 85.05 ||
      Math.abs(request.lng) > 180
    ) {
      throw new BadRequestException(
        `Radius must be 0-${MAX_PRELOAD_RADIUS_KM} km and zoom 0-${maxZoom}`,
      );
    }
    if (this.preload.active) {
      throw new ConflictException('A download is already running');
    }
    const tiles = tilesInRadius(
      request.lat,
      request.lng,
      request.radiusKm,
      request.minZoom,
      request.maxZoom,
    );
    if (tiles.length > MAX_PRELOAD_TILES) {
      throw new BadRequestException(
        `That area needs ${tiles.length} tiles; the limit is ${MAX_PRELOAD_TILES}. Shrink the radius or zoom range.`,
      );
    }
    this.preloadAbort = new AbortController();
    this.preload = {
      active: true,
      provider: provider.id,
      total: tiles.length,
      completed: 0,
      skipped: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    void this.runPreload(provider, tiles, this.preloadAbort.signal);
    return { total: tiles.length };
  }

  cancelPreload(): boolean {
    if (!this.preload.active || !this.preloadAbort) {
      return false;
    }
    this.preloadAbort.abort();
    return true;
  }

  async clearCache(): Promise<void> {
    this.cancelPreload();
    await rm(this.cacheDir, { recursive: true, force: true });
    this.cacheBytes = 0;
  }

  private async runPreload(
    provider: TileProvider,
    tiles: Array<[number, number, number]>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for (const [z, x, y] of tiles) {
        if (signal.aborted) {
          break;
        }
        const path = this.tilePath(provider, z, x, y);
        const cached = await this.readCached(provider, path);
        if (cached && cached.ageMs < REFRESH_AFTER_MS) {
          this.preload.skipped += 1;
          continue;
        }
        const data = await this.fetchOnce(provider, z, x, y, path, signal);
        if (data) {
          this.preload.completed += 1;
        } else {
          this.preload.failed += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, PRELOAD_DELAY_MS));
      }
    } finally {
      this.preload.active = false;
      this.preload.finishedAt = new Date().toISOString();
      this.preloadAbort = null;
      this.logger.log(
        `Tile download finished: ${this.preload.completed} fetched, ${this.preload.skipped} cached, ${this.preload.failed} failed of ${this.preload.total}`,
      );
    }
  }

  private tilePath(provider: TileProvider, z: number, x: number, y: number): string {
    const ext = provider.imageType === 'jpeg' ? 'jpg' : 'png';
    return join(this.cacheDir, provider.id, String(z), String(x), `${y}.${ext}`);
  }

  private async readCached(
    provider: TileProvider,
    path: string,
  ): Promise<{ data: Buffer; ageMs: number } | null> {
    try {
      const [data, info] = await Promise.all([readFile(path), stat(path)]);
      if (!isImage(data, provider.imageType)) {
        await unlink(path).catch(() => undefined);
        return null;
      }
      return { data, ageMs: Date.now() - info.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private fetchOnce(
    provider: TileProvider,
    z: number,
    x: number,
    y: number,
    path: string,
    signal?: AbortSignal,
  ): Promise<Buffer | null> {
    const existing = this.inflight.get(path);
    if (existing) {
      return existing;
    }
    const pending = this.fetchAndStore(provider, z, x, y, path, signal).finally(() =>
      this.inflight.delete(path),
    );
    this.inflight.set(path, pending);
    return pending;
  }

  private async fetchAndStore(
    provider: TileProvider,
    z: number,
    x: number,
    y: number,
    path: string,
    signal?: AbortSignal,
  ): Promise<Buffer | null> {
    await this.acquire();
    try {
      const response = await fetch(upstreamUrl(provider, z, x, y), {
        headers: { 'User-Agent': USER_AGENT },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
          : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return null;
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (!isImage(data, provider.imageType)) {
        return null;
      }
      await this.store(path, data);
      return data;
    } catch (error) {
      if (!signal?.aborted) {
        this.offlineUntil = Date.now() + OFFLINE_BACKOFF_MS;
        this.logger.warn(
          `Tile fetch failed, serving cache only for 30s: ${error instanceof Error ? error.message : error}`,
        );
      }
      return null;
    } finally {
      this.release();
    }
  }

  private async store(path: string, data: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, data);
    await rename(temp, path);
    if (this.cacheBytes !== null) {
      this.cacheBytes += data.length;
    }
    if ((await this.totalBytes()) > this.maxBytes) {
      void this.prune();
    }
  }

  private async totalBytes(): Promise<number> {
    if (this.cacheBytes === null) {
      this.cacheBytes = (await this.listFiles()).reduce((sum, file) => sum + file.size, 0);
    }
    return this.cacheBytes;
  }

  private async prune(): Promise<void> {
    if (this.pruning) {
      return;
    }
    this.pruning = true;
    try {
      const files = (await this.listFiles()).sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = files.reduce((sum, file) => sum + file.size, 0);
      const target = this.maxBytes * 0.9;
      for (const file of files) {
        if (total <= target) {
          break;
        }
        await unlink(file.path).catch(() => undefined);
        total -= file.size;
      }
      this.cacheBytes = total;
    } finally {
      this.pruning = false;
    }
  }

  private async listFiles(): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
          const info = await stat(full);
          out.push({ path: full, size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    };
    await walk(this.cacheDir);
    return out;
  }

  private acquire(): Promise<void> {
    if (this.activeFetches < MAX_CONCURRENT_FETCHES) {
      this.activeFetches += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.activeFetches -= 1;
    }
  }
}
