export type AlertTier = 'off' | 'alert' | 'critical';

export interface AlertSource {
  key: string;
  label: string;
  group: string;
  defaultTier: AlertTier;
}

const SENTINEL_TYPES: Array<[string, string]> = [
  ['DEAUTH_AP_TARGETED', 'Deauth aimed at an AP'],
  ['DEAUTH_FLOOD', 'Deauth flood'],
  ['DEAUTH_FORGE', 'Forged deauth'],
  ['AUTH_FLOOD', 'Auth flood'],
  ['SAE_DOS', 'WPA3 SAE denial of service'],
  ['ASSOC_SLEEP', 'Association sleep attack'],
  ['PMKID_HARVEST', 'PMKID harvesting'],
  ['PMKID_FORGE', 'Forged PMKID'],
  ['HSHK', 'Handshake capture'],
  ['EAPOL_BAIT', 'EAPOL bait'],
  ['EVILTWIN', 'Evil twin AP'],
  ['KARMA_CONFIRMED', 'Karma AP confirmed'],
  ['KARMA_CAND', 'Karma AP candidate'],
  ['BEACON_FORGE', 'Forged beacons'],
  ['BEACON_FLOOD', 'Beacon flood'],
  ['SSID_CONFUSION', 'SSID confusion'],
  ['OWE_ABUSE', 'OWE abuse'],
  ['PROBE_FLOOD', 'Probe flood'],
  ['PROBE_FLOOD_AP', 'Probe flood at an AP'],
  ['PROBE_FLOOD_BEHAVE', 'Probe flood (behavior)'],
  ['PWNAGOTCHI', 'Pwnagotchi'],
  ['ATTACKER_HUNT', 'Attacker hunting'],
  ['JAMMING', 'Jamming'],
  ['FRAG', 'Fragmentation attack'],
  ['RECON', 'Reconnaissance'],
];

const SENTINEL_NOTICE_TYPES = new Set([
  'RECON',
  'KARMA_CAND',
  'BEACON_FLOOD',
  'PROBE_FLOOD_BEHAVE',
]);

export const DEVICE_SOURCES: AlertSource[] = [
  ...SENTINEL_TYPES.map(([type, label]) => ({
    key: `sentinel:${type}`,
    label,
    group: 'Sentinel',
    defaultTier: SENTINEL_NOTICE_TYPES.has(type) ? ('off' as const) : ('alert' as const),
  })),
  {
    key: 'node:attack',
    label: 'Deauth / disassoc (ATTACK)',
    group: 'Attacks',
    defaultTier: 'alert',
  },
  { key: 'node:drone', label: 'Drone detected', group: 'Detections', defaultTier: 'off' },
  {
    key: 'node:anomaly',
    label: 'Baseline anomaly (new, returning, RSSI change)',
    group: 'Detections',
    defaultTier: 'off',
  },
  { key: 'target', label: 'Target detected (scan hit)', group: 'Detections', defaultTier: 'off' },
  { key: 'node:tamper', label: 'Tamper', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:vibration', label: 'Vibration', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:erase', label: 'Erase', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:mesh-guard', label: 'Mesh guard', group: 'Node security', defaultTier: 'alert' },
  {
    key: 'mqtt',
    label: 'Alerts from linked MQTT sites',
    group: 'Other sites',
    defaultTier: 'alert',
  },
];

const DEFAULTS = new Map(DEVICE_SOURCES.map((source) => [source.key, source.defaultTier]));

export const SOURCE_KEY =
  /^(rule:[A-Za-z0-9_-]{1,64}|sentinel:[A-Z_]{2,32}|node:[a-z-]{2,32}|target|mqtt)$/;

export function defaultTier(key: string): AlertTier {
  if (key.startsWith('rule:')) {
    return 'alert';
  }
  return DEFAULTS.get(key) ?? 'off';
}

export function nodeAlertSource(
  category: string | undefined,
  level: string,
  data: unknown,
): string | null {
  const cat = (category ?? '').toLowerCase();
  if (cat === 'sentinel') {
    const type = (data as { detectionType?: unknown } | null)?.detectionType;
    return typeof type === 'string' ? `sentinel:${type.toUpperCase()}` : null;
  }
  if (cat === 'attack' || cat === 'drone' || cat === 'anomaly') {
    return `node:${cat}`;
  }
  if (['tamper', 'vibration', 'erase', 'mesh-guard'].includes(cat) && level === 'ALERT') {
    return `node:${cat}`;
  }
  return null;
}
