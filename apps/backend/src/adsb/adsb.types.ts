export interface AdsbTrack {
  id: string;
  icao: string;
  callsign?: string | null;
  lat: number;
  lon: number;
  alt?: number | null;
  speed?: number | null;
  heading?: number | null;
  onGround?: boolean | null;
  firstSeen: string;
  lastSeen: string;
  siteId?: string | null;
  category?: string | null;
  reg?: string | null;
  dep?: string | null;
  dest?: string | null;
  typeCode?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  aircraftType?: string | null;
  categoryDescription?: string | null;
  country?: string | null;
  messages?: number | null;
}

export interface AdsbStatus {
  enabled: boolean;
  feedUrl: string;
  intervalMs: number;
  geofencesEnabled: boolean;
  lastPollAt?: string | null;
  lastError?: string | null;
  trackCount: number;
  aircraftDbCount?: number;
}
