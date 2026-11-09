import { readFileSync } from 'fs';
import { join } from 'path';

export type Radio = 'WIFI' | 'BLE';

export interface SignatureObservation {
  mac: string;
  radio: Radio;
  name: string;
  isAp: boolean;
}

export interface SignatureHit {
  id: string;
  name: string;
  kind: string;
}

export interface VendorHint {
  bucket: string;
  weight: number;
}

interface FleetRule {
  kind: string;
  text?: string;
  radio?: string | null;
  enabled?: boolean;
}

interface Fleet {
  id: string;
  name?: string;
  kind?: string;
  enabled?: boolean;
  matchAny?: boolean;
  rules?: FleetRule[];
  minPeers?: number;
  clusterByOui?: boolean;
  sequentialMac?: boolean;
}

interface Plan {
  fleet: Fleet;
  rules: FleetRule[];
  other: Array<(o: SignatureObservation) => boolean>;
}

const DATA_DIR = join(__dirname, '..', '..', 'data', 'classify');
const ADV_KINDS = new Set(['SERVICE_UUID', 'SERVICE_DATA', 'MANUFACTURER_ID', 'MANUFACTURER_DATA']);
const VENDOR_TABLES = [0, 1, 2, 3, 4].map((i) => `vendor_categories_${i}.tsv`);
const TABLE_BUCKETS = new Set([
  'camera',
  'bodyworn',
  'law-enforcement',
  'drone',
  'vehicle',
  'phone',
  'computer',
  'tv',
  'console',
  'audio',
  'wearable',
  'glasses',
  'health',
  'tag',
  'beacon',
  'lock',
  'home',
  'thermostat',
  'printer',
  'pos',
  'network',
  'router',
  'isp',
  'iot',
  'iot-module',
  'industrial',
  'signage',
  'hacking',
]);

export function hexOnly(raw: string): string {
  return raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

export function wifiOui24Universal(mac: string): string | null {
  const hex = hexOnly(mac);
  if (hex.length < 6) return null;
  const first = Number.parseInt(hex.slice(0, 2), 16);
  if (!Number.isFinite(first) || (first & 0x02) === 0 || (first & 0x01) !== 0) return null;
  return (first & 0xfd).toString(16).padStart(2, '0').toUpperCase() + hex.slice(2, 6);
}

function radioOf(raw: unknown): Radio | null {
  return raw === 'WIFI' || raw === 'BLE' ? raw : null;
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (const ch of pattern) {
    source += ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i');
}

function ruleScope(rule: FleetRule): Radio | null {
  if (rule.kind === 'VENDOR_IE_OUI' || rule.kind === 'HIDDEN_SSID') return 'WIFI';
  if (ADV_KINDS.has(rule.kind)) return radioOf(rule.radio) ?? 'BLE';
  return radioOf(rule.radio);
}

function radioScope(rules: FleetRule[]): Radio | null {
  let wifi = false;
  let ble = false;
  let both = false;
  for (const rule of rules) {
    const scope = ruleScope(rule);
    if (scope === 'WIFI') wifi = true;
    else if (scope === 'BLE') ble = true;
    else both = true;
  }
  if (both || (wifi && ble)) return null;
  if (wifi) return 'WIFI';
  if (ble) return 'BLE';
  return null;
}

function radioOk(o: SignatureObservation, rule: FleetRule): boolean {
  const radio = radioOf(rule.radio);
  return radio === null || o.radio === radio;
}

function compileOther(rule: FleetRule): ((o: SignatureObservation) => boolean) | null {
  const text = rule.text ?? '';
  switch (rule.kind) {
    case 'NAME_CONTAINS': {
      if (!text.trim()) return null;
      const needle = text.toLowerCase();
      return (o) => radioOk(o, rule) && o.name.length > 0 && o.name.toLowerCase().includes(needle);
    }
    case 'NAME_GLOB': {
      if (!text.trim()) return null;
      const re = globToRegExp(text);
      return (o) => radioOk(o, rule) && o.name.length > 0 && re.test(o.name);
    }
    case 'RADIO_KIND':
      return (o) => radioOk(o, rule);
    default:
      return null;
  }
}

export class SignatureCatalog {
  private readonly plans: Plan[] = [];
  private readonly wifiPlans: number[] = [];
  private readonly blePlans: number[] = [];
  private readonly bssidWifi = new Map<string, number[]>();
  private readonly bssidBle = new Map<string, number[]>();
  private readonly longOui: Array<{ hex: string; radio: Radio | null; idx: number }> = [];
  private readonly byId = new Map<string, Fleet>();
  private readonly handVendor: Array<{ token: string; bucket: string; weight: number }> = [];
  private readonly vendorTable = new Map<string, VendorHint>();

  constructor(fleets: Fleet[], handRules: string, vendorTables: string[]) {
    for (const fleet of fleets) {
      this.byId.set(fleet.id, fleet);
      const idx = this.plans.length;
      const active =
        fleet.enabled === false ? [] : (fleet.rules ?? []).filter((r) => r.enabled !== false);
      const other: Plan['other'] = [];
      for (const rule of active) {
        if (rule.kind === 'OUI' || rule.kind === 'MAC_PREFIX') {
          this.indexOui(rule.text ?? '', radioOf(rule.radio), idx);
        } else {
          const fn = compileOther(rule);
          if (fn) other.push(fn);
        }
      }
      this.plans.push({ fleet, rules: active, other });
      const cluster =
        (fleet.minPeers ?? 0) > 0 || fleet.clusterByOui === true || fleet.sequentialMac === true;
      if (cluster) continue;
      const scope = radioScope(active);
      if (scope !== 'BLE') this.wifiPlans.push(idx);
      if (scope !== 'WIFI') this.blePlans.push(idx);
    }

    for (const line of handRules.split('\n')) {
      const f = line.trimEnd().split('\t');
      if (f.length !== 4) continue;
      this.handVendor.push({ token: f[0].toLowerCase(), bucket: f[1], weight: Number(f[3]) || 0 });
    }

    for (const tsv of vendorTables) {
      for (const line of tsv.split('\n')) {
        const f = line.trimEnd().split('\t');
        if (f.length !== 3 || f[1] === 'unknown' || (f[2] !== 'h' && f[2] !== 'm')) continue;
        if (!TABLE_BUCKETS.has(f[1])) continue;
        this.vendorTable.set(f[0].toLowerCase(), { bucket: f[1], weight: f[2] === 'h' ? 3 : 2 });
      }
    }
  }

  get fleetCount(): number {
    return this.plans.length;
  }

  match(o: SignatureObservation): SignatureHit[] {
    const ouiHits = this.ouiHits(o);
    const hits: string[] = [];
    for (const idx of o.radio === 'WIFI' ? this.wifiPlans : this.blePlans) {
      if (this.fleetHits(o, this.plans[idx], ouiHits.has(idx))) hits.push(this.plans[idx].fleet.id);
    }
    const drop = (id: string) => {
      const i = hits.indexOf(id);
      if (i >= 0) hits.splice(i, 1);
    };
    if (
      hits.includes('fleet-ibeacon') &&
      hits.some((id) => id !== 'fleet-ibeacon' && this.byId.get(id)?.kind !== 'BEACON')
    ) {
      drop('fleet-ibeacon');
    }
    if (hits.includes('fleet-osmo') || hits.includes('fleet-dji-power')) drop('fleet-dji');
    if (hits.includes('fleet-meraki')) drop('fleet-cisco');
    if (
      hits.includes('fleet-airtag') &&
      !o.name.toLowerCase().includes('airtag') &&
      (hits.includes('fleet-apple-device') || hits.includes('fleet-apple-audio'))
    ) {
      drop('fleet-airtag');
    }
    return hits.map((id) => {
      const fleet = this.byId.get(id) as Fleet;
      return { id, name: fleet.name || id, kind: (fleet.kind ?? 'OTHER').toUpperCase() };
    });
  }

  vendorHint(vendor: string): VendorHint | null {
    const v = vendor.toLowerCase();
    let hand: VendorHint | null = null;
    for (const rule of this.handVendor) {
      if (wordMatch(v, rule.token)) {
        hand = { bucket: rule.bucket, weight: rule.weight };
        break;
      }
    }
    if (hand && hand.weight >= 2) return hand;
    return this.vendorTable.get(v) ?? hand;
  }

  private indexOui(text: string, radio: Radio | null, idx: number): void {
    const hex = hexOnly(text);
    if (!hex) return;
    if (hex.length !== 6) {
      this.longOui.push({ hex, radio, idx });
      return;
    }
    if (radio !== 'BLE') add(this.bssidWifi, hex, idx);
    if (radio !== 'WIFI') add(this.bssidBle, hex, idx);
  }

  private ouiHits(o: SignatureObservation): Set<number> {
    const hits = new Set<number>();
    const macHex = hexOnly(o.mac);
    const map = o.radio === 'WIFI' ? this.bssidWifi : this.bssidBle;
    for (const idx of map.get(macHex.slice(0, 6)) ?? []) hits.add(idx);
    if (o.radio === 'WIFI' && o.isAp) {
      const univ = wifiOui24Universal(o.mac);
      if (univ) for (const idx of map.get(univ) ?? []) hits.add(idx);
    }
    for (const l of this.longOui) {
      if (l.radio !== null && l.radio !== o.radio) continue;
      if (macHex && macHex.startsWith(l.hex)) hits.add(l.idx);
    }
    return hits;
  }

  private fleetHits(o: SignatureObservation, plan: Plan, ouiHit: boolean): boolean {
    if (plan.rules.length === 0) return false;
    if (plan.fleet.matchAny === false) return plan.rules.every((r) => ruleHits(o, r));
    if (ouiHit) return true;
    return plan.other.some((fn) => fn(o));
  }
}

function ruleHits(o: SignatureObservation, rule: FleetRule): boolean {
  if (rule.kind !== 'RADIO_KIND' && !radioOk(o, rule)) return false;
  const want = hexOnly(rule.text ?? '');
  switch (rule.kind) {
    case 'OUI': {
      if (want && hexOnly(o.mac).startsWith(want)) return true;
      const univ = o.radio === 'WIFI' && o.isAp ? wifiOui24Universal(o.mac) : null;
      return univ !== null && want.length === 6 && univ === want;
    }
    case 'MAC_PREFIX':
      return want.length > 0 && hexOnly(o.mac).startsWith(want);
    default:
      return compileOther(rule)?.(o) ?? false;
  }
}

function add(map: Map<string, number[]>, key: string, idx: number): void {
  const list = map.get(key);
  if (!list) map.set(key, [idx]);
  else if (!list.includes(idx)) list.push(idx);
}

export function wordMatch(value: string, token: string): boolean {
  const alnum = (i: number) => i >= 0 && i < value.length && /[a-z0-9]/.test(value[i]);
  for (let i = value.indexOf(token); i >= 0; i = value.indexOf(token, i + 1)) {
    if (!alnum(i - 1) && !alnum(i + token.length)) return true;
  }
  return false;
}

let catalog: SignatureCatalog | null = null;

export function signatureCatalog(): SignatureCatalog {
  if (catalog) return catalog;
  try {
    const parsed = JSON.parse(
      readFileSync(join(DATA_DIR, 'fieldwatch-signatures-v2.json'), 'utf8'),
    ) as {
      fleets?: Fleet[];
    };
    catalog = new SignatureCatalog(
      parsed.fleets ?? [],
      readFileSync(join(DATA_DIR, 'vendor_rules.tsv'), 'utf8'),
      VENDOR_TABLES.map((f) => readFileSync(join(DATA_DIR, f), 'utf8')),
    );
  } catch (err) {
    console.error(`[device-classification] signature data unavailable in ${DATA_DIR}:`, err);
    catalog = new SignatureCatalog([], '', []);
  }
  return catalog;
}
