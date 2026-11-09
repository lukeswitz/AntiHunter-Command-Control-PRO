import { signatureCatalog } from './signature-catalog';

export const DEVICE_FAMILIES = [
  'Phone',
  'Tag',
  'Audio',
  'Wearable',
  'Vehicle',
  'Drone',
  'Camera',
  'Radio',
  'Glasses',
  'Health',
  'Lock',
  'Home',
  'Computer',
  'Input',
  'Beacon',
  'Router',
  'Public Safety',
  'Hacking Tool',
] as const;

export type DeviceFamily = (typeof DEVICE_FAMILIES)[number];
export type ClassConfidence = 'high' | 'medium' | 'low';
export type ClassSource = 'advert' | 'name' | 'signature' | 'vendor' | 'address';

export interface ClassEvidence {
  source: ClassSource;
  value: string;
  family?: DeviceFamily;
}

export interface DeviceClassification {
  family: DeviceFamily | null;
  label: string | null;
  confidence: ClassConfidence | null;
  source: ClassSource | null;
  watch: boolean;
  evidence: ClassEvidence[];
}

export interface DeviceClassInput {
  mac: string;
  type?: string | null;
  name?: string | null;
  vendor?: string | null;
  bleClass?: string | null;
  locallyAdministered?: boolean | null;
  probeClient?: boolean | null;
}

interface Rule {
  re: RegExp;
  family: DeviceFamily;
  label?: string;
  confidence?: ClassConfidence;
}

const ADVERT_RULES: Rule[] = [
  {
    family: 'Phone',
    re: /^(Phone|iPhone|AirDrop|Handoff|Nearby|Hey-Siri|Tethering|WiFi-Settings|ExposureNotif|Samsung$|Google|FastPair|Continuum|CDP-(iPhone|iPad|Android|WinPhone))/,
  },
  { family: 'Tag', re: /^(Tag|FindMy|SmartTag|Tile|Keyring)/ },
  { family: 'Audio', re: /^(Audio|AirPods|Samsung-Buds|MediaPlayer)/ },
  { family: 'Wearable', re: /^(Wearable|Watch|HeartRate|Cycling)/ },
  { family: 'Vehicle', re: /^(Vehicle|Auto$)/ },
  { family: 'Drone', re: /^Drone/ },
  { family: 'Camera', re: /^Camera/ },
  { family: 'Radio', re: /^Radio/ },
  { family: 'Glasses', re: /^(Glasses|EyeGlasses)/ },
  { family: 'Health', re: /^(Health|BP$)/ },
  { family: 'Lock', re: /^Lock/ },
  {
    family: 'Home',
    re: /^(Home|HomeKit|Apple-TV|AirPlay|AirPrint|Display|Clock|Sensor|Environment|Robotic|Toy)/,
  },
  { family: 'Computer', re: /^(Computer|Microsoft|MS-|SwiftPair|CDP)/ },
  { family: 'Input', re: /^(Input|HID|Remote|Logitech|Barcode)/ },
  { family: 'Beacon', re: /^(Beacon|iBeacon|Eddystone)/ },
];

const NAME_RULES: Rule[] = [
  { family: 'Wearable', re: /\b(Apple Watch|Galaxy Watch\w*|Pixel Watch|HUAWEI WATCH\w*)/i },
  {
    family: 'Wearable',
    re: /\b(Fitbit|Charge \d|Versa \d?|Garmin|Forerunner|f[eē]nix|Venu|vivo(active|smart|move)\w*|Instinct|Polar|Amazfit|Mi (Smart )?Band|WHOOP|Oura|COROS|Suunto|Wahoo)\b/i,
  },
  { family: 'Tag', re: /\b(Tile|SmartTag\w*|AirTag|Chipolo|Pebblebee)\b/i },
  {
    family: 'Audio',
    re: /(AirPods( Pro| Max)?|Powerbeats|Beats|Galaxy Buds\w*|\bBuds\w*|\bJBL\b|\bBose\b|^LE-|WH-1000\w*|WF-1000\w*|Jabra|Soundcore|Sonos|Marshall|Skullcandy|Shokz|Sennheiser|Beoplay|Bang ?& ?Olufsen)/i,
  },
  { family: 'Drone', re: /\b(DJI|Mavic|Phantom \d|Anafi|Skydio|Autel|EVO II|TELLO|RemoteID)\b/i },
  {
    family: 'Camera',
    re: /(GoPro|Insta360|^Ring[- ]|Ring Setup|\bArlo\b|\bWyze\b|\bBlink\b|\beufy\b|Nest Cam|^Flock|Flock Safety|^Raven[-_ ]|Verkada|Hikvision|Reolink|Amcrest|Lorex|Rhombus|Axon Body|Body ?Cam|Dash ?cam|70mai|Nextbase)/i,
  },
  {
    family: 'Radio',
    re: /\b(Axon( Signal)?|APX\s?\w*|MOTOTRBO|Kenwood|L3Harris|Signal Sidearm)\b/i,
  },
  {
    family: 'Vehicle',
    re: /(\bTesla\b|\bModel [3SXY]\b|FordPass|\bSYNC\b|\bBMW\b|Mercedes|\bMB WLAN|\bAudi\b|\bVW\b|Volkswagen|Toyota|\bLexus\b|\bHonda\b|Hyundai|\bKia\b|Subaru|Uconnect|myChevrolet|Chevrolet|\bGMC\b|Cadillac|Rivian|Polestar|\bVolvo\b|Porsche|\bJeep\b|CarPlay|\bOBD(II|2)?\b|\bTPMS\b|\bVLINK\b|Car ?Kit)/i,
  },
  {
    family: 'Glasses',
    re: /\b(Ray-?Ban\w*|Meta Glasses|Spectacles|Vuzix|Even G\d|XREAL|Nreal|Rokid)\b/i,
  },
  {
    family: 'Health',
    re: /\b(Dexcom|Libre\s?\d?|Omnipod|Medtronic|Tandem|Omron|InPen|Contour|OneTouch|Accu-Chek|Owlet|ResMed|AirSense|Withings)\b/i,
  },
  {
    family: 'Lock',
    re: /\b(Yale|Schlage|August|Kwikset|Nuki|Lockly|ULTRALOQ|Level Lock|Master ?Lock)\b/i,
  },
  { family: 'Phone', re: /\b(iPhone|iPad)\b/i },
  { family: 'Phone', re: /\bGalaxy (S|A|Z|Note|M|Tab)\s?\w*/i },
  { family: 'Phone', re: /\bPixel( \d\w*| Fold| Tablet)?\b/i },
  {
    family: 'Phone',
    re: /\b(OnePlus|Redmi|POCO|moto [a-z]\w*|motorola edge|HUAWEI|HONOR|OPPO|vivo|realme|Nothing Phone|Android[_ -]?AP|AndroidAP\w*)\b/i,
  },
  {
    family: 'Input',
    re: /(Keyboard|Mouse|Trackpad|MX (Master|Keys|Anywhere)|\bLogi\b|Controller|DualSense|DUALSHOCK|Xbox Wireless|Joy-Con|Stylus|Apple Pencil)/i,
  },
  {
    family: 'Computer',
    re: /(MacBook\w*|iMac|Mac ?mini|Mac Studio|^DESKTOP-|^LAPTOP-|Surface|ThinkPad|\bXPS\b|Chromebook|raspberrypi)/i,
  },
  {
    family: 'Home',
    re: /(\bEcho\b|Alexa|Google Home|Nest (Mini|Hub|Audio|Wifi)|Chromecast|Roku|Fire ?TV|\bHue\b|SwitchBot|Govee|LIFX|\bKasa\b|\bTapo\b|\[TV\]|\bTV\b|Bravia|webOS|Vizio|^ESP[_-]|ESP32|Shelly|tasmota|Sonoff|ecobee|Roomba|iRobot|Printer|^DIRECT-\w{2}-|EPSON|Canon|Brother|Xbox|PlayStation|PS5|Nintendo|Apple TV|HomePod|Meross|Wemo|SmartLife)/i,
  },
  { family: 'Beacon', re: /\b(iBeacon|Eddystone|Kontakt|Estimote|Minew|Beacon)\b/i },
];

const VENDOR_RULES: Rule[] = [
  { family: 'Drone', re: /^(SZ DJI|PARROT|Skydio)/i, label: 'Drone maker' },
  {
    family: 'Camera',
    re: /^(Flock Safety|Verkada|Hangzhou Hikvision|Rhombus|GoPro|Wyze|Axis Communications|Arlo Technologies|Digital Ally|Utility, Inc)/i,
  },
  {
    family: 'Radio',
    re: /^(Motorola Solutions|Axon Enterprise|Harris Corporation|JVC KENWOOD|Kenwood|Inseego)/i,
  },
  {
    family: 'Vehicle',
    re: /^(Tesla,|Ford Motor|General Motors|BMW AG|Volkswagen|SAMSARA|Calamp|CradlePoint|Sierra Wireless|Peplink)/i,
  },
  { family: 'Wearable', re: /^(Garmin|Fitbit|Polar Electro|Suunto|OURA|Wahoo)/i },
  { family: 'Audio', re: /^(Bose Corp|SONOS|GN Audio|Sennheiser|Bang & Olufsen|Skullcandy)/i },
  { family: 'Health', re: /^(Medtronic|Dexcom|Insulet|Abbott Diabetes)/i },
  { family: 'Lock', re: /^(August Home|Allegion|ASSA ABLOY)/i },
  { family: 'Input', re: /^(Logitech|Audio BU - Logitech)/i },
  {
    family: 'Home',
    re: /^(Tuya|Signify|iRobot|Nest Labs|ecobee|Roku|Amazon Technologies|Nintendo|Sony Interactive)/i,
  },
  { family: 'Home', re: /^Espressif/i, label: 'ESP32 / IoT', confidence: 'low' },
  {
    family: 'Computer',
    re: /^(Intel Corporate|LITE-ON|AzureWave|Hewlett Packard|HP Inc|Dell Inc|Lenovo|Micro-Star|ASUSTek)/i,
    confidence: 'low',
  },
];

const SIGNATURE_FAMILY: Record<string, DeviceFamily> = {
  ISP: 'Router',
  MESH: 'Router',
  VEHICLE: 'Vehicle',
  SURVEILLANCE: 'Camera',
  CAMERA: 'Camera',
  HOME: 'Home',
  THERMOSTAT: 'Home',
  SIGNAGE: 'Home',
  LOCK: 'Lock',
  DRONE: 'Drone',
  WEARABLE: 'Wearable',
  BODYWORN: 'Wearable',
  LAW_ENFORCEMENT: 'Public Safety',
  HACKING: 'Hacking Tool',
  FINDER: 'Tag',
  AUDIO: 'Audio',
  GLASSES: 'Glasses',
  PHONE: 'Phone',
  BEACON: 'Beacon',
  HEALTH: 'Health',
};

const BUCKET_FAMILY: Record<string, DeviceFamily> = {
  camera: 'Camera',
  radio: 'Radio',
  router: 'Router',
  network: 'Router',
  isp: 'Router',
  health: 'Health',
  tag: 'Tag',
  vehicle: 'Vehicle',
  home: 'Home',
  thermostat: 'Home',
  signage: 'Home',
  tv: 'Home',
  console: 'Home',
  printer: 'Home',
  drone: 'Drone',
  phone: 'Phone',
  computer: 'Computer',
  audio: 'Audio',
  'audio-personal': 'Audio',
  lock: 'Lock',
  wearable: 'Wearable',
  glasses: 'Glasses',
  beacon: 'Beacon',
  bodyworn: 'Public Safety',
  'law-enforcement': 'Public Safety',
  hacking: 'Hacking Tool',
};

const WATCH_FAMILIES: ReadonlySet<DeviceFamily> = new Set([
  'Tag',
  'Camera',
  'Radio',
  'Drone',
  'Public Safety',
  'Hacking Tool',
]);
const RANK: Record<ClassConfidence, number> = { low: 0, medium: 1, high: 2 };

function match(rules: Rule[], text: string | null | undefined) {
  const value = text?.trim();
  if (!value) return null;
  for (const rule of rules) {
    const m = rule.re.exec(value);
    if (m) return { rule, text: m[0].trim() };
  }
  return null;
}

function shortVendor(vendor: string): string {
  return vendor
    .replace(/^(SZ|Hangzhou|Beijing|Shenzhen)\s+/i, '')
    .split(/[,(]| (Inc|Co|Corp|Corporation|Ltd|LLC|Oy|AG|SA|Technologies|Technology)\b/i)[0]
    .trim();
}

export function bleAddressKind(mac: string): string | null {
  const msb = Number.parseInt(mac.slice(0, 2), 16);
  if (!Number.isFinite(msb)) return null;
  switch (msb & 0xc0) {
    case 0xc0:
      return 'static random';
    case 0x40:
      return 'resolvable private';
    case 0x00:
      return null;
    default:
      return null;
  }
}

export function classifyDeviceType(input: DeviceClassInput): DeviceClassification {
  const evidence: ClassEvidence[] = [];
  const picks: Array<{
    family: DeviceFamily;
    source: ClassSource;
    confidence: ClassConfidence;
    label: string;
  }> = [];
  const isBle = (input.type ?? '').trim().toUpperCase() === 'BLE';

  const advert = input.bleClass?.trim();
  if (advert) {
    const m = match(ADVERT_RULES, advert);
    evidence.push({ source: 'advert', value: advert, family: m?.rule.family });
    if (m) {
      picks.push({ family: m.rule.family, source: 'advert', confidence: 'high', label: advert });
    }
  }

  const ownName = input.probeClient ? null : input.name;
  const nameMatch = match(NAME_RULES, ownName);
  if (nameMatch) {
    const fragment = /[-_[\]]$|^\[/.test(nameMatch.text);
    const nameLabel = fragment ? (ownName ?? '').trim().slice(0, 24) : nameMatch.text;
    evidence.push({ source: 'name', value: nameLabel, family: nameMatch.rule.family });
    picks.push({
      family: nameMatch.rule.family,
      source: 'name',
      confidence: nameMatch.rule.confidence ?? 'medium',
      label: nameMatch.rule.label ?? nameLabel,
    });
  }

  const vendor = input.vendor?.trim();
  const vendorMatch = vendor ? match(VENDOR_RULES, vendor) : null;
  const hint =
    !vendor || vendorMatch || input.locallyAdministered
      ? null
      : signatureCatalog().vendorHint(vendor);
  const hintFamily = hint ? BUCKET_FAMILY[hint.bucket] : undefined;
  if (vendor) {
    evidence.push({
      source: 'vendor',
      value: shortVendor(vendor) || vendor,
      family: vendorMatch?.rule.family ?? hintFamily,
    });
  }
  if (vendor && vendorMatch) {
    picks.push({
      family: vendorMatch.rule.family,
      source: 'vendor',
      confidence: vendorMatch.rule.confidence ?? 'medium',
      label: vendorMatch.rule.label ?? (shortVendor(vendor) || vendor),
    });
  }

  const ssidOrName = (ownName ?? '').trim();
  for (const hit of signatureCatalog().match({
    mac: input.mac,
    radio: isBle ? 'BLE' : 'WIFI',
    name: ssidOrName,
    isAp: !isBle && ssidOrName.length > 0,
  })) {
    const family = SIGNATURE_FAMILY[hit.kind];
    evidence.push({ source: 'signature', value: hit.name, family });
    if (family) {
      picks.push({ family, source: 'signature', confidence: 'medium', label: hit.name });
    }
  }

  if (vendor && hint && hintFamily) {
    picks.push({
      family: hintFamily,
      source: 'vendor',
      confidence: hint.weight >= 3 ? 'medium' : 'low',
      label: shortVendor(vendor) || vendor,
    });
  }

  if (isBle) {
    const kind = vendor ? null : bleAddressKind(input.mac);
    if (kind) evidence.push({ source: 'address', value: kind });
  } else if (input.locallyAdministered && ssidOrName) {
    evidence.push({ source: 'address', value: 'randomized' });
  } else if (input.locallyAdministered) {
    evidence.push({ source: 'address', value: 'randomized', family: 'Phone' });
    picks.push({
      family: 'Phone',
      source: 'address',
      confidence: 'low',
      label: 'Private Wi-Fi address',
    });
  }

  const primary = picks[0];
  if (!primary) {
    return {
      family: null,
      label: advert ?? null,
      confidence: null,
      source: null,
      watch: false,
      evidence,
    };
  }

  const agreeing = new Set(picks.filter((p) => p.family === primary.family).map((p) => p.source));
  const best = picks
    .filter((p) => p.family === primary.family)
    .reduce((acc, p) => (RANK[p.confidence] > RANK[acc] ? p.confidence : acc), primary.confidence);
  const confidence: ClassConfidence =
    agreeing.size >= 2 && best !== 'high' ? (best === 'low' ? 'medium' : 'high') : best;

  return {
    family: primary.family,
    label: primary.label,
    confidence,
    source: primary.source,
    watch: WATCH_FAMILIES.has(primary.family),
    evidence,
  };
}
