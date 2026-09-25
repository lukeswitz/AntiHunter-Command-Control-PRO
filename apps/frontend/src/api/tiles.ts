import { useQuery } from '@tanstack/react-query';

import { apiClient } from './client';

export interface TileStatus {
  online: boolean;
  providers: Array<{ id: string; maxZoom: number; preload: boolean }>;
  cache: { bytes: number; maxBytes: number };
  preload: {
    active: boolean;
    provider: string | null;
    total: number;
    completed: number;
    skipped: number;
    failed: number;
    startedAt: string | null;
    finishedAt: string | null;
  };
}

export interface PreloadRequest {
  provider: string;
  lat: number;
  lng: number;
  radiusKm: number;
  minZoom: number;
  maxZoom: number;
}

export const getTileStatus = () => apiClient.get<TileStatus>('/tiles/status');
export const startTilePreload = (body: PreloadRequest) =>
  apiClient.post<{ total: number }>('/tiles/preload', body);
export const cancelTilePreload = () => apiClient.delete<{ canceled: boolean }>('/tiles/preload');
export const clearTileCache = () => apiClient.delete<{ ok: boolean }>('/tiles/cache');

export function useTileKey(enabled = true): string | null {
  const query = useQuery({
    queryKey: ['tile-key'],
    queryFn: () => apiClient.get<{ key: string }>('/tiles/key'),
    enabled,
    staleTime: 60 * 60 * 1000,
    refetchInterval: 6 * 60 * 60 * 1000,
  });
  return query.data?.key ?? null;
}

export function cachedTileUrl(provider: string, key: string): string {
  return `/api/tiles/${provider}/{z}/{x}/{y}?k=${encodeURIComponent(key)}`;
}
