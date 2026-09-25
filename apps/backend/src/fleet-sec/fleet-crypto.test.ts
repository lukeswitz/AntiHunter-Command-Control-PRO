import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  channelHash,
  decodeKeyB64,
  deriveX25519Public,
  encodeKeyB64,
  fingerprint,
  fingerprintEqual,
  generatePskAvoidingCollision,
  generateX25519KeyPair,
  keyPairMatches,
  randomPsk,
  validatePsk,
  validateX25519PublicKey,
} from './fleet-crypto';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

// RFC 7748 §6.1 test vectors.
const ALICE_PRIV = Buffer.from(
  '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
  'hex',
);
const ALICE_PUB = Buffer.from(
  '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
  'hex',
);
const BOB_PRIV = Buffer.from(
  '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb',
  'hex',
);
const BOB_PUB = Buffer.from(
  'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
  'hex',
);

console.log('x25519');
test('derives RFC 7748 Alice and Bob public keys from private keys', () => {
  assert.ok(deriveX25519Public(ALICE_PRIV).equals(ALICE_PUB));
  assert.ok(deriveX25519Public(BOB_PRIV).equals(BOB_PUB));
});
test('generated keypair round-trips through derive', () => {
  const kp = generateX25519KeyPair();
  assert.equal(kp.privateKey.length, 32);
  assert.equal(kp.publicKey.length, 32);
  assert.ok(deriveX25519Public(kp.privateKey).equals(kp.publicKey));
  assert.ok(keyPairMatches(kp.privateKey, kp.publicKey));
});
test('keyPairMatches rejects a mismatched pair', () => {
  assert.ok(!keyPairMatches(ALICE_PRIV, BOB_PUB));
});
test('rejects malformed public keys', () => {
  assert.throws(() => validateX25519PublicKey(Buffer.alloc(31)));
  assert.throws(() => validateX25519PublicKey(Buffer.alloc(32)));
});

console.log('fingerprint');
test('fingerprint is 8 colon-separated hex bytes of SHA-256(key)', () => {
  const fp = fingerprint(ALICE_PUB);
  assert.match(fp, /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
  const h = createHash('sha256').update(ALICE_PUB).digest('hex');
  const expected = (h.match(/.{2}/g) as string[]).slice(0, 8).join(':');
  assert.equal(fp, expected);
});
test('fingerprintEqual is true only for identical fingerprints', () => {
  assert.ok(fingerprintEqual(fingerprint(ALICE_PUB), fingerprint(ALICE_PUB)));
  assert.ok(!fingerprintEqual(fingerprint(ALICE_PUB), fingerprint(BOB_PUB)));
});

console.log('channel hash');
test('channelHash matches firmware xor(name) ^ xor(psk)', () => {
  const psk = Buffer.from([0x01, 0x02, 0x04]);
  assert.equal(channelHash('', psk), 0x07);
  assert.equal(channelHash('AB', Buffer.alloc(0)), 0x41 ^ 0x42);
  assert.equal(channelHash('AB', psk), 0x41 ^ 0x42 ^ 0x07);
});

console.log('psk');
test('validatePsk accepts 0/16/32 only', () => {
  validatePsk(Buffer.alloc(0));
  validatePsk(Buffer.alloc(16));
  validatePsk(Buffer.alloc(32));
  assert.throws(() => validatePsk(Buffer.alloc(1)));
  assert.throws(() => validatePsk(Buffer.alloc(24)));
});
test('randomPsk produces the requested length', () => {
  assert.equal(randomPsk(0).length, 0);
  assert.equal(randomPsk(16).length, 16);
  assert.equal(randomPsk(32).length, 32);
  assert.throws(() => randomPsk(8));
});
test('generatePskAvoidingCollision avoids used channel hashes', () => {
  const used = new Set<number>();
  const first = generatePskAvoidingCollision(16, used);
  used.add(channelHash('', first));
  for (let i = 0; i < 20; i += 1) {
    const psk = generatePskAvoidingCollision(16, used);
    assert.ok(!used.has(channelHash('', psk)));
    used.add(channelHash('', psk));
  }
});

console.log('base64');
test('base64 round-trips a key', () => {
  assert.ok(decodeKeyB64(encodeKeyB64(ALICE_PUB)).equals(ALICE_PUB));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
