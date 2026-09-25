import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = readFileSync(join(backendDir, '.env'), 'utf8');
const baseUrl = /^DATABASE_URL=["']?([^"'\n]+)/m.exec(envFile)?.[1];
if (!baseUrl) {
  throw new Error('DATABASE_URL not found in apps/backend/.env');
}
const dbName = 'ahcc_e2e_recovery';
const adminUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const testUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
const port = 3105;
const api = `http://127.0.0.1:${port}/api`;
const adminEmail = 'e2e-admin@ahcc.local';
const adminPassword = 'E2eAdminPass123!';

const mails = [];
const smtp = createServer((socket) => {
  let buffer = '';
  let inData = false;
  socket.write('220 sink\r\n');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        mails.push(buffer.slice(0, end));
        buffer = buffer.slice(end + 5);
        inData = false;
        socket.write('250 queued\r\n');
        continue;
      }
      const lineEnd = buffer.indexOf('\r\n');
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd).toUpperCase();
      buffer = buffer.slice(lineEnd + 2);
      if (line.startsWith('EHLO') || line.startsWith('HELO')) socket.write('250 sink\r\n');
      else if (line.startsWith('DATA')) {
        inData = true;
        socket.write('354 go\r\n');
      } else if (line.startsWith('QUIT')) {
        socket.end('221 bye\r\n');
        return;
      } else socket.write('250 ok\r\n');
    }
  });
});

const psql = (url, sql) =>
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], { encoding: 'utf8' }).trim();

let passed = 0;
let failed = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  PASS ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const call = async (method, path, body, token) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
};

const decodeQuotedPrintable = (text) =>
  text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

const waitForMail = async (count, timeoutMs = 8000) => {
  const start = Date.now();
  while (mails.length < count && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return mails.length >= count ? decodeQuotedPrintable(mails[count - 1]) : null;
};

const tokenFrom = (mail, path) => new RegExp(`${path}\\?token=([0-9a-f]+)`).exec(mail ?? '')?.[1];

const login = (email, password) => call('POST', '/auth/login', { email, password });

let backend;
let backendLog = '';
const cleanup = () => {
  if (backend && backend.exitCode === null) backend.kill('SIGTERM');
  smtp.close();
};

try {
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const smtpPort = smtp.address().port;

  psql(adminUrl, `DROP DATABASE IF EXISTS ${dbName}`);
  psql(adminUrl, `CREATE DATABASE ${dbName}`);
  const env = {
    ...process.env,
    DATABASE_URL: testUrl,
    PORT: String(port),
    LISTEN_HOST: '127.0.0.1',
    HTTP_PREFIX: 'api',
    SERIAL_DEVICE: '',
    NODE_ENV: 'production',
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
    APP_URL: 'http://localhost:5173',
    RATE_LIMIT_RECOVERY_LIMIT: '30',
    TS_AUTHKEY: '',
    AHCC_MATTER_ENABLED: 'false',
  };
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: backendDir, env, stdio: 'ignore' });
  execFileSync('npx', ['prisma', 'db', 'seed'], { cwd: backendDir, env, stdio: 'ignore' });
  psql(
    testUrl,
    `UPDATE "AppConfig" SET "mailEnabled"=true, "mailHost"='127.0.0.1', "mailPort"=${smtpPort}, "mailSecure"=false, "mailPreview"=false, "mailFrom"='ahcc@test.local'`,
  );
  psql(testUrl, `UPDATE "User" SET "legalAcceptedAt"=now() WHERE email='${adminEmail}'`);

  backend = spawn('node', ['dist/main.js'], {
    cwd: backendDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [backend.stdout, backend.stderr]) {
    stream.on('data', (chunk) => {
      backendLog = (backendLog + chunk.toString()).slice(-6000);
    });
  }
  for (let i = 0; i < 80; i += 1) {
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log('forgot password');
  const first = await login(adminEmail, adminPassword);
  check('admin login works', first.status === 201 || first.status === 200, JSON.stringify(first));
  const oldSession = first.json.token;
  check(
    'old session valid before reset',
    (await call('GET', '/auth/me', null, oldSession)).status === 200,
  );

  const unknown = await call('POST', '/auth/forgot-password', { email: 'nobody@ahcc.local' });
  const known = await call('POST', '/auth/forgot-password', { email: adminEmail });
  check('unknown email gets 200', unknown.status === 200);
  check(
    'same reply for known and unknown email',
    JSON.stringify(unknown.json) === JSON.stringify(known.json),
  );
  const mail1 = await waitForMail(1);
  const token1 = tokenFrom(mail1, 'reset-password');
  check('reset email sent to account with link', Boolean(token1) && mail1.includes(adminEmail));
  await new Promise((resolve) => setTimeout(resolve, 800));
  check('no email for unknown address', mails.length === 1, `mails=${mails.length}`);

  const stored = psql(testUrl, `SELECT token FROM "PasswordResetToken" WHERE "consumedAt" IS NULL`);
  check(
    'token stored as sha256, not raw',
    stored === createHash('sha256').update(token1).digest('hex'),
  );

  await call('POST', '/auth/forgot-password', { email: adminEmail });
  const token2 = tokenFrom(await waitForMail(2), 'reset-password');
  check('second request sends new token', Boolean(token2) && token2 !== token1);
  const staleReset = await call('POST', '/auth/reset-password', {
    token: token1,
    password: 'Whatever123!',
  });
  check(
    'older token voided by newer request',
    staleReset.status === 400,
    JSON.stringify(staleReset),
  );

  const newPassword = 'NewAdminPass456!';
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const reset = await call('POST', '/auth/reset-password', {
    token: token2,
    password: newPassword,
  });
  check('reset with valid token', reset.status === 200, JSON.stringify(reset));
  const revoked = await call('GET', '/auth/me', null, oldSession);
  check('session from before reset rejected', revoked.status === 401, JSON.stringify(revoked));
  check('old password rejected', (await login(adminEmail, adminPassword)).status === 401);
  const fresh = await login(adminEmail, newPassword);
  check('new password works', fresh.status === 201 || fresh.status === 200, JSON.stringify(fresh));
  check(
    'new session valid',
    (await call('GET', '/auth/me', null, fresh.json.token)).status === 200,
  );
  const reuse = await call('POST', '/auth/reset-password', {
    token: token2,
    password: 'Another123!',
  });
  check('token cannot be reused', reuse.status === 400);

  await call('POST', '/auth/forgot-password', { email: adminEmail });
  const token3 = tokenFrom(await waitForMail(3), 'reset-password');
  psql(
    testUrl,
    `UPDATE "PasswordResetToken" SET "expiresAt"=now() - interval '1 minute' WHERE "consumedAt" IS NULL`,
  );
  const expired = await call('POST', '/auth/reset-password', {
    token: token3,
    password: 'Another123!',
  });
  check('expired token rejected', expired.status === 400);
  const bogus = await call('POST', '/auth/reset-password', {
    token: 'a'.repeat(64),
    password: 'Another123!',
  });
  check('unknown token rejected', bogus.status === 400);
  const shortPassword = await call('POST', '/auth/reset-password', {
    token: token3,
    password: 'short',
  });
  check('short password rejected by validation', shortPassword.status === 400);

  psql(
    testUrl,
    `UPDATE "User" SET "lockedAt"=now(), "lockedReason"='TOO_MANY_FAILURES', "failedLoginAttempts"=3 WHERE email='${adminEmail}'`,
  );
  await call('POST', '/auth/forgot-password', { email: adminEmail });
  const token4 = tokenFrom(await waitForMail(4), 'reset-password');
  await call('POST', '/auth/reset-password', { token: token4, password: newPassword });
  const unlocked = psql(
    testUrl,
    `SELECT coalesce("lockedAt"::text,'null') || '|' || "failedLoginAttempts" FROM "User" WHERE email='${adminEmail}'`,
  );
  check('reset clears lockout', unlocked === 'null|0', unlocked);

  console.log('invitations');
  const admin = await login(adminEmail, newPassword);
  const inviteEmail = 'e2e-invitee@ahcc.local';
  const invite = await call(
    'POST',
    '/users/invitations',
    { email: inviteEmail, role: 'ANALYST' },
    admin.json.token,
  );
  check(
    'admin creates invitation',
    invite.status === 201 || invite.status === 200,
    JSON.stringify(invite),
  );
  const inviteToken = tokenFrom(await waitForMail(5), 'accept-invite');
  check('invitation email has link', Boolean(inviteToken));
  const accept = await call('POST', '/auth/accept-invite', {
    token: inviteToken,
    password: 'InviteePass789!',
    firstName: 'Eve',
  });
  check('invitation accepted', accept.status === 200, JSON.stringify(accept));
  const invitee = await login(inviteEmail, 'InviteePass789!');
  check(
    'invited user can log in',
    invitee.status === 201 || invitee.status === 200,
    JSON.stringify(invitee),
  );
  check(
    'invited user has invitation role',
    invitee.json?.user?.role === 'ANALYST',
    invitee.json?.user?.role,
  );
  const acceptAgain = await call('POST', '/auth/accept-invite', {
    token: inviteToken,
    password: 'InviteePass789!',
  });
  check('invitation cannot be reused', acceptAgain.status === 400);
  const badInvite = await call('POST', '/auth/accept-invite', {
    token: 'b'.repeat(64),
    password: 'InviteePass789!',
  });
  check('unknown invitation rejected', badInvite.status === 400);

  console.log('rate limit');
  let limited = false;
  for (let i = 0; i < 35 && !limited; i += 1) {
    limited =
      (await call('POST', '/auth/forgot-password', { email: 'nobody@ahcc.local' })).status === 429;
  }
  check('recovery endpoints rate limited', limited);
} catch (error) {
  failed += 1;
  console.log(`  FAIL harness: ${error instanceof Error ? error.message : error}`);
  console.log(`--- backend log tail ---\n${backendLog}`);
} finally {
  cleanup();
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    psql(adminUrl, `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  } catch (error) {
    console.log(`  cleanup: ${error instanceof Error ? error.message : error}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
