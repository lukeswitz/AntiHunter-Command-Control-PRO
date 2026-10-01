import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const X25519_KEY_SIZE = 32;
export const FINGERPRINT_LEN = 8;
export const VALID_PSK_LENGTHS = [0, 16, 32];

const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface KeyPair {
  privateKey: Buffer;
  publicKey: Buffer;
}

export function generateX25519KeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(12),
  };
}

export function deriveX25519Public(priv: Buffer): Buffer {
  validateX25519PrivateKey(priv);
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, priv]),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(12);
}

export function validateX25519PublicKey(pub: Buffer): void {
  if (pub.length !== X25519_KEY_SIZE) {
    throw new Error(`public key must be ${X25519_KEY_SIZE} bytes, got ${pub.length}`);
  }
  if (pub.every((b) => b === 0)) {
    throw new Error('public key is all zero');
  }
}

export function validateX25519PrivateKey(priv: Buffer): void {
  if (priv.length !== X25519_KEY_SIZE) {
    throw new Error(`private key must be ${X25519_KEY_SIZE} bytes, got ${priv.length}`);
  }
  if (priv.every((b) => b === 0)) {
    throw new Error('private key is all zero');
  }
}

export function keyPairMatches(priv: Buffer, pub: Buffer): boolean {
  try {
    return deriveX25519Public(priv).equals(pub);
  } catch {
    return false;
  }
}

export function fingerprint(key: Buffer): string {
  const hash = createHash('sha256').update(key).digest();
  const parts: string[] = [];
  for (let i = 0; i < FINGERPRINT_LEN; i += 1) {
    parts.push(hash.subarray(i, i + 1).toString('hex'));
  }
  return parts.join(':');
}

export function fingerprintEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function channelHash(name: string, psk: Buffer): number {
  let h = 0;
  for (const byte of Buffer.from(name, 'utf8')) {
    h ^= byte;
  }
  for (const byte of psk) {
    h ^= byte;
  }
  return h;
}

export function validatePsk(psk: Buffer): void {
  if (!VALID_PSK_LENGTHS.includes(psk.length)) {
    throw new Error(`invalid PSK length ${psk.length} (allowed: 0, 16, 32)`);
  }
}

export function randomPsk(size: number): Buffer {
  if (!VALID_PSK_LENGTHS.includes(size)) {
    throw new Error(`invalid PSK size ${size} (allowed: 0, 16, 32)`);
  }
  return size === 0 ? Buffer.alloc(0) : randomBytes(size);
}

export function generatePskAvoidingCollision(size: number, usedHashes: Set<number>): Buffer {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const psk = randomPsk(size);
    if (!usedHashes.has(channelHash('', psk))) {
      return psk;
    }
  }
  throw new Error('could not generate a PSK avoiding channel-hash collision');
}

export function encodeKeyB64(key: Buffer): string {
  return key.toString('base64');
}

export function decodeKeyB64(value: string): Buffer {
  return Buffer.from(value.trim(), 'base64');
}
