export interface NodeSnapshot {
  id: string;
  name?: string | null;
  lat?: number | null;
  lon?: number | null;
  ts: Date;
  lastMessage?: string | null;
  lastSeen?: Date | null;
  siteId?: string | null;
  siteName?: string | null;
  siteColor?: string | null;
  siteCountry?: string | null;
  siteCity?: string | null;
  originSiteId?: string | null;
  temperatureC?: number | null;
  temperatureF?: number | null;
  temperatureUpdatedAt?: Date | null;
}

export interface NodeDiff {
  type: 'upsert' | 'remove';
  node: NodeSnapshot;
}
