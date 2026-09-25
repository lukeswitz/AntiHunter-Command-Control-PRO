import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TilesService } from './tiles.service';
import {
  isImage,
  isTileInRange,
  latLngToTile,
  signTileKey,
  TILE_PROVIDERS,
  tilesInRadius,
  upstreamUrl,
  verifyTileKey,
} from './tiles.util';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 2)]);

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function main() {
  console.log('tile math');
  await test('latLngToTile matches independent reference values', () => {
    assert.deepEqual(latLngToTile(51.507, -0.128, 10), [511, 340]);
    assert.deepEqual(latLngToTile(40.713, -74.006, 12), [1205, 1540]);
    assert.deepEqual(latLngToTile(-33.869, 151.209, 14), [15073, 9831]);
    assert.deepEqual(latLngToTile(0, 0, 1), [1, 1]);
    assert.deepEqual(latLngToTile(85.05, 179.99, 3), [7, 0]);
  });
  await test('tilesInRadius covers the center tile at every zoom', () => {
    const tiles = tilesInRadius(40.713, -74.006, 2, 10, 13);
    for (let z = 10; z <= 13; z += 1) {
      const [x, y] = latLngToTile(40.713, -74.006, z);
      assert.ok(
        tiles.some(([tz, tx, ty]) => tz === z && tx === x && ty === y),
        `zoom ${z}`,
      );
    }
    assert.equal(new Set(tiles.map((tile) => tile.join('/'))).size, tiles.length);
  });
  await test('isTileInRange rejects out-of-bounds and over-zoom tiles', () => {
    const osm = TILE_PROVIDERS.osm;
    assert.ok(isTileInRange(osm, 2, 3, 3));
    assert.ok(!isTileInRange(osm, 2, 4, 0));
    assert.ok(!isTileInRange(osm, 20, 0, 0));
    assert.ok(!isTileInRange(osm, -1, 0, 0));
    assert.ok(!isTileInRange(osm, 1.5, 0, 0));
  });
  await test('upstreamUrl fills template and rotates subdomains', () => {
    assert.equal(
      upstreamUrl(TILE_PROVIDERS.osm, 3, 1, 2),
      'https://tile.openstreetmap.org/3/1/2.png',
    );
    assert.equal(
      upstreamUrl(TILE_PROVIDERS['usgs-topo'], 10, 211, 385),
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/10/385/211',
    );
    assert.equal(
      upstreamUrl(TILE_PROVIDERS.topography, 5, 1, 1),
      'https://c.tile.opentopomap.org/5/1/1.png',
    );
  });
  await test('isImage checks magic bytes', () => {
    assert.ok(isImage(PNG, 'png'));
    assert.ok(isImage(JPEG, 'jpeg'));
    assert.ok(!isImage(JPEG, 'png'));
    assert.ok(!isImage(Buffer.from('<html>blocked</html>'), 'png'));
  });
  await test('OSM and Esri are view-only; USGS and OpenTopoMap allow download', () => {
    assert.equal(TILE_PROVIDERS.osm.preload, false);
    assert.equal(TILE_PROVIDERS.satellite.preload, false);
    assert.equal(TILE_PROVIDERS.dark.preload, false);
    assert.equal(TILE_PROVIDERS['usgs-topo'].preload, true);
    assert.equal(TILE_PROVIDERS['usgs-imagery'].preload, true);
    assert.equal(TILE_PROVIDERS.topography.preload, true);
  });

  console.log('tile keys');
  const secret = 'x'.repeat(48);
  const now = Date.UTC(2026, 8, 25, 12);
  await test('key valid today and yesterday, invalid after', () => {
    const key = signTileKey(secret, 'user1', now);
    assert.ok(verifyTileKey(secret, key, now));
    assert.ok(verifyTileKey(secret, key, now + 86_400_000));
    assert.ok(!verifyTileKey(secret, key, now + 2 * 86_400_000));
  });
  await test('tampered or foreign keys rejected', () => {
    const key = signTileKey(secret, 'user1', now);
    const [, day, sig] = key.split('.');
    assert.ok(!verifyTileKey(secret, `user2.${day}.${sig}`, now));
    assert.ok(!verifyTileKey('y'.repeat(48), key, now));
    assert.ok(!verifyTileKey(secret, undefined, now));
    assert.ok(!verifyTileKey(secret, 'garbage', now));
  });

  console.log('tile service');
  const cacheDir = mkdtempSync(join(tmpdir(), 'ahcc-tiles-'));
  process.env.AHCC_TILE_CACHE = cacheDir;
  process.env.AHCC_TILE_CACHE_MAX_MB = '64';
  process.env.JWT_SECRET = secret;
  const realFetch = globalThis.fetch;
  const requested: string[] = [];
  let mode: 'ok' | 'down' | 'html' = 'ok';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    if (mode === 'down') {
      throw new TypeError('fetch failed');
    }
    const body =
      mode === 'html'
        ? Buffer.from('<html>no</html>')
        : String(input).endsWith('.png')
          ? PNG
          : JPEG;
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  try {
    const service = new TilesService();
    await test('first request fetches and caches, second is served from disk', async () => {
      const first = await service.getTile('osm', 3, 1, 2);
      assert.equal(first?.source, 'MISS');
      assert.equal(requested.length, 1);
      const second = await service.getTile('osm', 3, 1, 2);
      assert.equal(second?.source, 'HIT');
      assert.equal(requested.length, 1);
      assert.ok(statSync(join(cacheDir, 'osm', '3', '1', '2.png')).isFile());
    });
    await test('User-Agent names the app (OSM policy)', async () => {
      let agent = '';
      const spy = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        agent = new Headers(init?.headers).get('user-agent') ?? '';
        return spy(input, init);
      }) as typeof fetch;
      await service.getTile('osm', 4, 1, 1);
      globalThis.fetch = spy;
      assert.match(agent, /^AntiHunter-Command-Center/);
    });
    await test('non-image upstream reply is not cached', async () => {
      mode = 'html';
      const result = await service.getTile('osm', 4, 2, 2);
      assert.equal(result, null);
      assert.throws(() => statSync(join(cacheDir, 'osm', '4', '2', '2.png')));
      mode = 'ok';
    });
    await test('network down: stale tile served, missing tile returns null', async () => {
      const path = join(cacheDir, 'osm', '3', '1', '2.png');
      const old = (Date.now() - 40 * 86_400_000) / 1000;
      utimesSync(path, old, old);
      mode = 'down';
      const stale = await service.getTile('osm', 3, 1, 2);
      assert.equal(stale?.source, 'STALE');
      assert.equal(service.isOnline(), false);
      const missing = await service.getTile('osm', 5, 5, 5);
      assert.equal(missing, null);
      mode = 'ok';
    });
    await test('bad tile coordinates rejected', async () => {
      await assert.rejects(() => service.getTile('osm', 2, 9, 0));
      await assert.rejects(() => service.getTile('nope', 1, 0, 0));
    });

    const fresh = new TilesService();
    await test('offline download refused for OSM', () => {
      assert.throws(
        () =>
          fresh.startPreload({
            provider: 'osm',
            lat: 40,
            lng: -74,
            radiusKm: 1,
            minZoom: 10,
            maxZoom: 12,
          }),
        /does not allow offline download/,
      );
    });
    await test('offline download refused when over tile limit', () => {
      assert.throws(
        () =>
          fresh.startPreload({
            provider: 'usgs-topo',
            lat: 40,
            lng: -74,
            radiusKm: 50,
            minZoom: 1,
            maxZoom: 16,
          }),
        /limit is 10000/,
      );
    });
    await test('offline download fetches every tile, then skips cached ones', async () => {
      requested.length = 0;
      const { total } = fresh.startPreload({
        provider: 'usgs-topo',
        lat: 40.713,
        lng: -74.006,
        radiusKm: 1,
        minZoom: 10,
        maxZoom: 11,
      });
      assert.ok(total > 0);
      while (fresh.preloadState().active) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const first = fresh.preloadState();
      assert.equal(first.completed, total, JSON.stringify(first));
      assert.equal(requested.length, total);
      fresh.startPreload({
        provider: 'usgs-topo',
        lat: 40.713,
        lng: -74.006,
        radiusKm: 1,
        minZoom: 10,
        maxZoom: 11,
      });
      while (fresh.preloadState().active) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(fresh.preloadState().skipped, total);
      assert.equal(requested.length, total);
    });
    await test('offline download can be canceled', async () => {
      fresh.startPreload({
        provider: 'topography',
        lat: 40.713,
        lng: -74.006,
        radiusKm: 5,
        minZoom: 10,
        maxZoom: 14,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(fresh.cancelPreload());
      while (fresh.preloadState().active) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const state = fresh.preloadState();
      assert.ok(
        state.completed + state.skipped + state.failed < state.total,
        JSON.stringify(state),
      );
    });
    await test('cache over its size cap evicts oldest tiles first', async () => {
      await fresh.clearCache();
      process.env.AHCC_TILE_CACHE_MAX_MB = '1';
      const capped = new TilesService();
      const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(200 * 1024, 3)]);
      globalThis.fetch = (async () => new Response(big, { status: 200 })) as typeof fetch;
      for (let x = 0; x < 8; x += 1) {
        await capped.getTile('osm', 4, x, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const stats = await capped.cacheStats();
      assert.ok(stats.bytes <= stats.maxBytes, JSON.stringify(stats));
      assert.throws(() => statSync(join(cacheDir, 'osm', '4', '0', '0.png')));
      assert.ok(statSync(join(cacheDir, 'osm', '4', '7', '0.png')).isFile());
    });
    await test('clear cache empties the directory', async () => {
      await fresh.clearCache();
      assert.deepEqual(
        readdirSync(join(cacheDir, '..')).includes(cacheDir.split('/').pop() ?? ''),
        false,
      );
      assert.equal((await fresh.cacheStats()).bytes, 0);
    });
  } finally {
    globalThis.fetch = realFetch;
    rmSync(cacheDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
