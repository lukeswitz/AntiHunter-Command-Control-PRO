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
  lastSeen: string;
}

export interface AdsbStatus {
  enabled: boolean;
  feedUrl: string;
  intervalMs: number;
  lastPollAt?: string | null;
  lastError?: string | null;
  trackCount: number;
}
