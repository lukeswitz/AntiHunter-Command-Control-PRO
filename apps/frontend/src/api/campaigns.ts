import type { DeviceClassification } from './types';

export interface CampaignSummary {
  name: string;
  active: boolean;
  startedAt: string;
  endedAt: string | null;
  nodes: string[];
  devices: number;
}

export interface CampaignDevice {
  mac: string;
  hits: number;
  firstSeen: string;
  lastSeen: string;
  nodes: string[];
  vendor: string | null;
  type: string | null;
  ssid: string | null;
  maxRSSI: number | null;
  classification: DeviceClassification | null;
}

export interface CampaignDetail extends CampaignSummary {
  runs: Array<{ nodeId: string; startedAt: string; endedAt: string | null }>;
  deviceList: CampaignDevice[];
}
