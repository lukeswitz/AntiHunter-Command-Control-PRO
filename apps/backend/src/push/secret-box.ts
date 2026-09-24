import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PREFIX = 'enc:v1:';

function loadKey(): Buffer {
  const fromEnv = process.env.REMOTE_ALERTS_SECRET_KEY?.trim();
  if (fromEnv) {
    return createHash('sha256').update(fromEnv, 'utf8').digest();
  }
  const path =
    process.env.REMOTE_ALERTS_KEY_FILE?.trim() ||
    join(process.cwd(), '.secrets', 'remote-alerts.key');
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
