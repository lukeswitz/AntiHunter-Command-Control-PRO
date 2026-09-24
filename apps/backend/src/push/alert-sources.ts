export type AlertTier = 'off' | 'alert' | 'critical';

export interface AlertSource {
  key: string;
  label: string;
  group: string;
  defaultTier: AlertTier;
}

export const DEVICE_SOURCES: AlertSource[] = [
  { key: 'sentinel', label: 'Wi-Fi attacks', group: 'Attacks', defaultTier: 'alert' },
  { key: 'node:attack', label: 'Deauth / disassoc', group: 'Attacks', defaultTier: 'alert' },
  { key: 'target', label: 'Target detected', group: 'Detections', defaultTier: 'off' },
  { key: 'node:drone', label: 'Drone', group: 'Detections', defaultTier: 'off' },
  { key: 'node:anomaly', label: 'Baseline anomaly', group: 'Detections', defaultTier: 'off' },
  { key: 'node:tamper', label: 'Tamper', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:vibration', label: 'Vibration', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:erase', label: 'Erase', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:mesh-guard', label: 'Mesh guard', group: 'Node security', defaultTier: 'alert' },
  { key: 'mqtt', label: 'Linked MQTT sites', group: 'Other sites', defaultTier: 'alert' },
];

const DEFAULTS = new Map(DEVICE_SOURCES.map((source) => [source.key, source.defaultTier]));

export const SOURCE_KEY = /^(rule:[A-Za-z0-9_-]{1,64}|sentinel|node:[a-z-]{2,32}|target|mqtt)$/;

export function defaultTier(key: string): AlertTier {
  if (key.startsWith('rule:')) {
    return 'alert';
  }
  return DEFAULTS.get(key) ?? 'off';
}

export function nodeAlertSource(
  category: string | undefined,
  level: string,
  _data: unknown,
): string | null {
  const cat = (category ?? '').toLowerCase();
  if (cat === 'sentinel') {
    return level === 'ALERT' ? 'sentinel' : null;
  }
  if (cat === 'attack' || cat === 'drone' || cat === 'anomaly') {
    return `node:${cat}`;
  }
  if (['tamper', 'vibration', 'erase', 'mesh-guard'].includes(cat) && level === 'ALERT') {
    return `node:${cat}`;
  }
  return null;
}
