import { apiClient } from './client';
import type { AdsbStatus, AdsbTrack } from './types';

export interface Dump1090Aircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number;
  alt_geom?: number;
  gs?: number;
  track?: number;
  seen?: number;
  nav_heading?: number;
  category?: string;
  reg?: string;
  reg_num?: string;
  r?: string;
  dep?: string;
  dest?: string;
  cntry?: string;
  country?: string;
  messages?: number;
}

export interface Dump1090AircraftResponse {
  aircraft?: Dump1090Aircraft[];
}

export function getAdsbStatus() {
  return apiClient.get<AdsbStatus>('/adsb/status');
}

export function getAdsbTracks() {
  return apiClient.get<AdsbTrack[]>('/adsb/tracks');
}

export function getAdsbLog() {
  return apiClient.get<AdsbTrack[]>('/adsb/log');
}

export function clearAdsbLog() {
  return apiClient.delete<{ cleared: boolean }>('/adsb/log');
}

export function updateAdsbConfig(body: {
  enabled?: boolean;
  feedUrl?: string;
  intervalMs?: number;
  geofencesEnabled?: boolean;
}) {
  return apiClient.post<AdsbStatus>('/adsb/config', body);
}

export function fetchAdsbProxy() {
  return apiClient.get<Dump1090AircraftResponse>('/adsb/proxy');
}

export async function getAdsbTracksViaProxy(): Promise<AdsbTrack[]> {
  const payload = await fetchAdsbProxy();
  return normalizeDump1090Response(payload);
}

export function normalizeDump1090Response(payload: Dump1090AircraftResponse): AdsbTrack[] {
  const aircraft = Array.isArray(payload?.aircraft) ? payload?.aircraft : [];
  const now = Date.now();
  return aircraft
    .map((entry) => {
      if (typeof entry.lat !== 'number' || typeof entry.lon !== 'number') {
        return null;
      }
      const hex = (entry.hex ?? '').trim().toUpperCase();
      if (!hex) {
        return null;
      }
      const alt = entry.alt_geom ?? entry.alt_baro ?? null;
      const timestamp = new Date(now - (entry.seen ?? 0) * 1000).toISOString();
      return {
        id: hex,
        icao: hex,
        callsign: (entry.flight ?? '').trim() || null,
        lat: entry.lat,
        lon: entry.lon,
        alt: typeof alt === 'number' ? alt : null,
        speed: typeof entry.gs === 'number' ? entry.gs : null,
        heading: typeof entry.track === 'number' ? entry.track : null,
        onGround: null,
        firstSeen: timestamp,
        lastSeen: timestamp,
        siteId: null,
        category: typeof entry.category === 'string' ? entry.category.trim() || null : null,
        reg:
          typeof entry.reg === 'string' && entry.reg.trim()
            ? entry.reg.trim()
            : typeof entry.r === 'string' && entry.r.trim()
              ? entry.r.trim()
              : typeof entry.reg_num === 'string' && entry.reg_num.trim()
                ? entry.reg_num.trim()
                : null,
        dep: typeof entry.dep === 'string' ? entry.dep.trim() || null : null,
        dest: typeof entry.dest === 'string' ? entry.dest.trim() || null : null,
        country:
          typeof entry.cntry === 'string' && entry.cntry.trim()
            ? entry.cntry.trim()
            : typeof entry.country === 'string' && entry.country.trim()
              ? entry.country.trim()
              : null,
        messages: typeof entry.messages === 'number' ? entry.messages : null,
      } as AdsbTrack;
    })
    .filter((track): track is AdsbTrack => track !== null);
}

export function uploadAircraftDatabase(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  return apiClient.upload('/adsb/database', formData);
}
