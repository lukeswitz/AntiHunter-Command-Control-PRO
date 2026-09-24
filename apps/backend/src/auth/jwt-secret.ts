import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function loadJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const path = process.env.JWT_SECRET_FILE?.trim() || join(process.cwd(), '.secrets', 'jwt.key');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(48).toString('base64'), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(path, 0o600);
  const secret = readFileSync(path, 'utf8').trim();
  if (secret.length < 32) {
    throw new Error(`JWT secret file ${path} is too short`);
  }
  return secret;
}
