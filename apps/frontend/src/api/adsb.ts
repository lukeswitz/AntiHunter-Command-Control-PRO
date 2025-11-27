import { apiClient } from './client';
import type { AdsbStatus, AdsbTrack } from './types';

export function getAdsbStatus() {
  return apiClient.get<AdsbStatus>('/adsb/status');
}

export function getAdsbTracks() {
  return apiClient.get<AdsbTrack[]>('/adsb/tracks');
}

export function updateAdsbConfig(body: {
  enabled?: boolean;
  feedUrl?: string;
  intervalMs?: number;
}) {
  return apiClient.post<AdsbStatus>('/adsb/config', body);
}
