import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const PREFIX = 'enc:v1:';
const CREDENTIAL_NAME = 'remote-alerts-key';
const KEYCHAIN_SERVICE = 'AHCC remote alerts';
const KEYCHAIN_ACCOUNT = 'remote-alerts-key';

function decodeKey(raw: string, source: string): Buffer {
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`Remote alerts key from ${source} is not a base64 32-byte key`);
  }
  return key;
}

function keychain(args: string[]): string | null {
  try {
    return execFileSync('/usr/bin/security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function loadFromKeychain(legacyPath: string): Buffer {
  const lookup = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'];
  const stored = keychain(lookup);
  if (stored) {
    return decodeKey(stored, 'the macOS Keychain');
  }
  const value = existsSync(legacyPath)
    ? readFileSync(legacyPath, 'utf8').trim()
    : randomBytes(32).toString('base64');
  decodeKey(value, existsSync(legacyPath) ? legacyPath : 'a new key');
  keychain([
    'add-generic-password',
    '-U',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    KEYCHAIN_ACCOUNT,
    '-w',
    value,
  ]);
  if (keychain(lookup) !== value) {
    throw new Error('Could not store the remote alerts key in the macOS Keychain');
  }
  if (existsSync(legacyPath)) {
    unlinkSync(legacyPath);
  }
  return decodeKey(value, 'the macOS Keychain');
}

function loadKey(): Buffer {
  const fromEnv = process.env.REMOTE_ALERTS_SECRET_KEY?.trim();
  if (fromEnv) {
    return createHash('sha256').update(fromEnv, 'utf8').digest();
  }
  const credentials = process.env.CREDENTIALS_DIRECTORY?.trim();
  if (credentials && existsSync(join(credentials, CREDENTIAL_NAME))) {
    return decodeKey(
      readFileSync(join(credentials, CREDENTIAL_NAME), 'utf8'),
      `systemd credential ${CREDENTIAL_NAME}`,
    );
  }
  const path =
    process.env.REMOTE_ALERTS_KEY_FILE?.trim() ||
    join(process.cwd(), '.secrets', 'remote-alerts.key');
  if (process.platform === 'darwin' && !process.env.REMOTE_ALERTS_KEY_FILE) {
    return loadFromKeychain(path);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(path, 0o600);
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (key.length !== 32) {
    throw new Error(`Remote alerts key file ${path} is not a base64 32-byte key`);
  }
  return key;
}

export class SecretBox {
  private key: Buffer | null = null;

  private getKey(): Buffer {
    this.key ??= loadKey();
    return this.key;
  }

  derive(label: string): string {
    return createHmac('sha256', this.getKey()).update(label, 'utf8').digest('base64url');
  }

  isSealed(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getKey(), iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  open(sealed: string): string {
    const buffer = Buffer.from(sealed.slice(PREFIX.length), 'base64');
    if (buffer.length < 29) {
      throw new Error('Sealed secret is truncated');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.getKey(), buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
  }
}
