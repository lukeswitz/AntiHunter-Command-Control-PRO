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
  depTime?: string | null;
  destTime?: string | null;
  depDistanceM?: number | null;
  destDistanceM?: number | null;
  depCandidates?: number | null;
  destCandidates?: number | null;
  routeSource?: 'feed' | 'opensky' | null;
  typeCode?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  aircraftType?: string | null;
  categoryDescription?: string | null;
  country?: string | null;
  messages?: number | null;
  depIata?: string | null;
  destIata?: string | null;
  depIcao?: string | null;
  destIcao?: string | null;
  depAirport?: string | null;
  destAirport?: string | null;
  photoUrl?: string | null;
  photoThumbUrl?: string | null;
  photoAuthor?: string | null;
  photoSourceUrl?: string | null;
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
  openskyEnabled?: boolean;
  openskyClientId?: string | null;
}
