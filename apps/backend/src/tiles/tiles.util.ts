import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TileProvider {
  id: string;
  upstream: string;
  subdomains?: string[];
  maxZoom: number;
  imageType: 'png' | 'jpeg';
  preload: boolean;
}

export const TILE_PROVIDERS: Record<string, TileProvider> = {
  osm: {
    id: 'osm',
    upstream: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    imageType: 'png',
    preload: false,
  },
  satellite: {
    id: 'satellite',
    upstream:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    imageType: 'jpeg',
    preload: false,
  },
  'usgs-topo': {
    id: 'usgs-topo',
    upstream:
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 16,
    imageType: 'jpeg',
    preload: true,
  },
  'usgs-imagery': {
    id: 'usgs-imagery',
    upstream:
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 16,
    imageType: 'jpeg',
    preload: true,
  },
  topography: {
    id: 'topography',
    upstream: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    maxZoom: 17,
    imageType: 'png',
    preload: true,
  },
  dark: {
    id: 'dark',
    upstream:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 16,
    imageType: 'jpeg',
    preload: false,
  },
};

export const MAX_PRELOAD_TILES = 10_000;
export const MAX_PRELOAD_RADIUS_KM = 50;
export const MAX_PRELOAD_ZOOM = 16;

export function isTileInRange(provider: TileProvider, z: number, x: number, y: number): boolean {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > provider.maxZoom) {
    return false;
  }
  const max = 2 ** z - 1;
  return x >= 0 && y >= 0 && x <= max && y <= max;
}

export function upstreamUrl(provider: TileProvider, z: number, x: number, y: number): string {
  if (TILE_PROVIDERS[provider.id] !== provider || !isTileInRange(provider, z, x, y)) {
    throw new Error('Unknown map source or tile out of range');
  }
  const zs = encodeURIComponent(z);
  const xs = encodeURIComponent(x);
  const ys = encodeURIComponent(y);
  const path = `${zs}/${xs}/${ys}`;
  const arcgis = `${zs}/${ys}/${xs}`;
  switch (provider.id) {
    case 'osm':
      return `https://tile.openstreetmap.org/${path}.png`;
    case 'satellite':
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${arcgis}`;
    case 'usgs-topo':
      return `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${arcgis}`;
    case 'usgs-imagery':
      return `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${arcgis}`;
    case 'topography':
      switch ((x + y) % 3) {
        case 0:
          return `https://a.tile.opentopomap.org/${path}.png`;
        case 1:
          return `https://b.tile.opentopomap.org/${path}.png`;
        default:
          return `https://c.tile.opentopomap.org/${path}.png`;
      }
    case 'dark':
      return `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${arcgis}`;
    default:
      throw new Error('Unknown map source');
  }
}

export function isImage(data: Buffer, type: TileProvider['imageType']): boolean {
  if (type === 'jpeg') {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  return (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

export function latLngToTile(lat: number, lng: number, zoom: number): [number, number] {
  const n = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lng + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  const clamp = (value: number) => Math.min(n - 1, Math.max(0, value));
  return [clamp(x), clamp(y)];
}

export function tilesInRadius(
  lat: number,
  lng: number,
  radiusKm: number,
  minZoom: number,
  maxZoom: number,
): Array<[number, number, number]> {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const tiles: Array<[number, number, number]> = [];
  for (let z = minZoom; z <= maxZoom; z += 1) {
    const [x1, y1] = latLngToTile(lat + dLat, lng - dLng, z);
    const [x2, y2] = latLngToTile(lat - dLat, lng + dLng, z);
    for (let x = x1; x <= x2; x += 1) {
      for (let y = y1; y <= y2; y += 1) {
        tiles.push([z, x, y]);
      }
    }
  }
  return tiles;
}

const DAY_MS = 86_400_000;

function signature(secret: string, userId: string, day: number): string {
  return createHmac('sha256', secret).update(`tiles:${userId}:${day}`).digest('base64url');
}

export function signTileKey(secret: string, userId: string, now = Date.now()): string {
  const day = Math.floor(now / DAY_MS);
  return `${userId}.${day}.${signature(secret, userId, day)}`;
}

export function verifyTileKey(secret: string, key: string | undefined, now = Date.now()): boolean {
  const [userId, dayText, sig] = (key ?? '').split('.');
  const day = Number(dayText);
  const today = Math.floor(now / DAY_MS);
  if (!userId || !sig || !Number.isInteger(day) || (day !== today && day !== today - 1)) {
    return false;
  }
  const expected = Buffer.from(signature(secret, userId, day));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
