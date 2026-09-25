import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
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
    SERIAL_DEVICE: '/dev/null-ahcc-e2e',
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
  psql(
    testUrl,
    `INSERT INTO "SerialConfig" (id, enabled, "updatedAt") VALUES ('serial', false, now()) ON CONFLICT (id) DO UPDATE SET enabled=false`,
  );

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

  const serialState = await fetch(`${api}/serial/state`, {
    headers: {
      authorization: `Bearer ${(await login(adminEmail, adminPassword)).json.token}`,
    },
  }).then((response) => response.json());
  check(
    'test backend never opens a serial port',
    serialState.connected === false,
    JSON.stringify(serialState),
  );

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

  console.log('tiles');
  const adminToken = admin.json.token;
  psql(testUrl, `UPDATE "User" SET "legalAcceptedAt"=now() WHERE email='${inviteEmail}'`);
  const analystToken = (await login(inviteEmail, 'InviteePass789!')).json.token;
  const analystMe = await call('GET', '/auth/me', null, analystToken);
  check('analyst session fully accepted', analystMe.json?.legalAccepted === true);
  const noKey = await fetch(`${api}/tiles/osm/1/0/0`);
  check('tile without key rejected', noKey.status === 401, String(noKey.status));
  const forged = await fetch(`${api}/tiles/osm/1/0/0?k=someone.20000.abc`);
  check('tile with forged key rejected', forged.status === 401, String(forged.status));
  const keyReply = await call('GET', '/tiles/key', null, adminToken);
  check('logged-in user gets tile key', keyReply.status === 200 && Boolean(keyReply.json?.key));
  const keyAnon = await call('GET', '/tiles/key');
  check('tile key needs login', keyAnon.status === 401);
  const tileKey = encodeURIComponent(keyReply.json?.key ?? '');
  const outOfRange = await fetch(`${api}/tiles/osm/2/9/0?k=${tileKey}`);
  check('out-of-range tile rejected', outOfRange.status === 400, String(outOfRange.status));
  const unknownSource = await fetch(`${api}/tiles/nope/1/0/0?k=${tileKey}`);
  check('unknown map source rejected', unknownSource.status === 400, String(unknownSource.status));
  const tileStatus = await call('GET', '/tiles/status', null, adminToken);
  check(
    'status lists download-allowed sources',
    tileStatus.status === 200 &&
      tileStatus.json.providers.find((p) => p.id === 'osm')?.preload === false &&
      tileStatus.json.providers.find((p) => p.id === 'usgs-topo')?.preload === true,
    JSON.stringify(tileStatus.json?.providers),
  );
  check('status needs login', (await call('GET', '/tiles/status')).status === 401);
  const area = { lat: 40.713, lng: -74.006, radiusKm: 1, minZoom: 10, maxZoom: 11 };
  const osmPreload = await call('POST', '/tiles/preload', { ...area, provider: 'osm' }, adminToken);
  check('OSM offline download refused', osmPreload.status === 400, JSON.stringify(osmPreload));
  const analystPreload = await call(
    'POST',
    '/tiles/preload',
    { ...area, provider: 'usgs-topo' },
    analystToken,
  );
  check(
    'analyst cannot start download',
    analystPreload.status === 403 &&
      JSON.stringify(analystPreload.json).includes('INSUFFICIENT_ROLE'),
    JSON.stringify(analystPreload),
  );
  const badArea = await call(
    'POST',
    '/tiles/preload',
    { ...area, provider: 'usgs-topo', radiusKm: 500 },
    adminToken,
  );
  check('oversized area rejected', badArea.status === 400);
  const analystClear = await call('DELETE', '/tiles/cache', null, analystToken);
  check(
    'analyst cannot clear cache',
    analystClear.status === 403 && JSON.stringify(analystClear.json).includes('INSUFFICIENT_ROLE'),
    JSON.stringify(analystClear),
  );

  console.log('status broadcast');
  const defaults = await call('GET', '/config/app', null, adminToken);
  check(
    'broadcast settings default off',
    defaults.json?.statusBroadcastEnabled === false &&
      defaults.json?.statusBroadcastGps === false &&
      defaults.json?.statusReplyEnabled === false &&
      defaults.json?.statusBroadcastIntervalSec === 600,
    JSON.stringify(defaults.json),
  );
  const saved = await call(
    'PUT',
    '/config/app',
    { statusBroadcastEnabled: true, statusBroadcastIntervalSec: 300, statusBroadcastGps: true },
    adminToken,
  );
  check(
    'broadcast settings save',
    saved.status === 200 &&
      saved.json?.statusBroadcastEnabled === true &&
      saved.json?.statusBroadcastIntervalSec === 300 &&
      saved.json?.statusBroadcastGps === true,
    JSON.stringify(saved),
  );
  const tooFast = await call('PUT', '/config/app', { statusBroadcastIntervalSec: 30 }, adminToken);
  check('interval under 60 s rejected', tooFast.status === 400);
  const manual = await call('POST', '/status-broadcast/send', null, adminToken);
  check(
    'send without a radio reports why',
    manual.status === 200 &&
      manual.json?.sent === false &&
      /Radio not identified/.test(manual.json?.reason),
    JSON.stringify(manual),
  );
  const lastBroadcast = await call('GET', '/status-broadcast', null, adminToken);
  check('last result readable', lastBroadcast.json?.last?.sent === false);
  const analystSend = await call('POST', '/status-broadcast/send', null, analystToken);
  check(
    'analyst cannot send broadcast',
    analystSend.status === 403 && JSON.stringify(analystSend.json).includes('INSUFFICIENT_ROLE'),
    JSON.stringify(analystSend),
  );

  console.log('radio');
  const radioInfo = await call('GET', '/radio', null, analystToken);
  check(
    'radio info readable by any user',
    radioInfo.status === 200 && radioInfo.json?.connected === false,
    JSON.stringify(radioInfo),
  );
  const rebootNoRadio = await call('POST', '/radio/reboot', { seconds: 2 }, adminToken);
  check(
    'radio action without a radio explains why',
    rebootNoRadio.status === 400 &&
      /not identified|not connected/i.test(rebootNoRadio.json?.message),
    JSON.stringify(rebootNoRadio),
  );
  const badSeconds = await call('POST', '/radio/reboot', { seconds: 99999 }, adminToken);
  check('out-of-range reboot delay rejected', badSeconds.status === 400);
  const badGps = await call('POST', '/radio/gps-mode', { gpsMode: 7 }, adminToken);
  check('unknown GPS mode rejected', badGps.status === 400);
  const analystReboot = await call('POST', '/radio/reboot', { seconds: 2 }, analystToken);
  check(
    'analyst cannot reboot radio',
    analystReboot.status === 403 &&
      JSON.stringify(analystReboot.json).includes('INSUFFICIENT_ROLE'),
    JSON.stringify(analystReboot),
  );
  const analystRefresh = await call('POST', '/radio/refresh', null, analystToken);
  check(
    'analyst cannot send radio requests',
    analystRefresh.status === 403 &&
      JSON.stringify(analystRefresh.json).includes('INSUFFICIENT_ROLE'),
    JSON.stringify(analystRefresh),
  );

  console.log('fleet security');
  const fleetIdentities = await call('GET', '/fleet-security/identities', null, analystToken);
  check(
    'fleet identities readable, empty at start',
    fleetIdentities.status === 200 &&
      Array.isArray(fleetIdentities.json) &&
      fleetIdentities.json.length === 0,
    JSON.stringify(fleetIdentities.json),
  );
  const fleetTrust = await call('GET', '/fleet-security/trust', null, analystToken);
  check('fleet trust roster readable', fleetTrust.status === 200 && Array.isArray(fleetTrust.json));
  const fleetPolicy = await call('GET', '/fleet-security/policy', null, analystToken);
  check(
    'fleet policy has defaults',
    fleetPolicy.status === 200 && fleetPolicy.json?.expectedIsManaged === false,
    JSON.stringify(fleetPolicy.json),
  );
  const fleetChannels = await call('GET', '/fleet-security/channels', null, analystToken);
  check(
    'fleet channels readable',
    fleetChannels.status === 200 && Array.isArray(fleetChannels.json),
  );

  const pubDer = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' });
  const pubB64 = Buffer.from(pubDer.subarray(12)).toString('base64');
  const analystRegister = await call(
    'POST',
    '/fleet-security/identities',
    { label: 'op-key', publicKey: pubB64, role: 'operator' },
    analystToken,
  );
  check(
    'analyst cannot register identity',
    analystRegister.status === 403 &&
      JSON.stringify(analystRegister.json).includes('INSUFFICIENT_ROLE'),
    JSON.stringify(analystRegister),
  );
  const register = await call(
    'POST',
    '/fleet-security/identities',
    { label: 'op-key', publicKey: pubB64, role: 'operator' },
    adminToken,
  );
  check(
    'admin registers an operator identity',
    (register.status === 201 || register.status === 200) && Boolean(register.json?.fingerprint),
    JSON.stringify(register),
  );
  const identitiesAfter = await call('GET', '/fleet-security/identities', null, adminToken);
  check(
    'registered identity shows in the list',
    identitiesAfter.json?.some((i) => i.fingerprint === register.json.fingerprint),
  );

  const rekey = await call(
    'PUT',
    '/fleet-security/trust/305419896/admin-keys',
    { keyFingerprints: [register.json.fingerprint] },
    adminToken,
  );
  check(
    'OTA admin-key change refused to protect the node keypair (finding #17)',
    rekey.status === 400 && /regenerate the node keypair/i.test(rekey.json?.message ?? ''),
    JSON.stringify(rekey),
  );

  const badRotate = await call(
    'POST',
    '/fleet-security/rotations',
    { channelIndex: 0, targets: [123456], ack: 'NOPE' },
    adminToken,
  );
  check('rotation without ack=ROTATE rejected', badRotate.status === 400);
  const analystRotate = await call(
    'POST',
    '/fleet-security/rotations',
    { channelIndex: 0, targets: [123456], ack: 'ROTATE' },
    analystToken,
  );
  check(
    'analyst cannot start rotation',
    analystRotate.status === 403 &&
      JSON.stringify(analystRotate.json).includes('INSUFFICIENT_ROLE'),
    JSON.stringify(analystRotate),
  );
  const rotate = await call(
    'POST',
    '/fleet-security/rotations',
    { channelIndex: 0, targets: [123456], ack: 'ROTATE', notes: 'e2e' },
    adminToken,
  );
  check(
    'admin creates a rotation (random PSK, fingerprint only)',
    (rotate.status === 201 || rotate.status === 200) &&
      Boolean(rotate.json?.rotationId) &&
      /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/.test(rotate.json?.newPskFingerprint ?? ''),
    JSON.stringify(rotate),
  );
  const rotationRow = await call(
    'GET',
    `/fleet-security/rotations/${rotate.json.rotationId}`,
    null,
    adminToken,
  );
  check(
    'rotation row readable and never exposes the PSK',
    rotationRow.status === 200 &&
      rotationRow.json?.newPskFp === rotate.json.newPskFingerprint &&
      !('newPsk' in (rotationRow.json ?? {})),
    JSON.stringify(rotationRow.json),
  );
  const analystPolicy = await call(
    'PUT',
    '/fleet-security/policy',
    { expectedIsManaged: true },
    analystToken,
  );
  check('analyst cannot change policy', analystPolicy.status === 403);

  console.log('disabled accounts');
  check(
    'analyst session valid before disable',
    (await call('GET', '/auth/me', null, analystToken)).status === 200,
  );
  const disable = await call('DELETE', `/users/${analystMe.json.user.id}`, null, adminToken);
  check('admin disables analyst', disable.status === 200, JSON.stringify(disable));
  const afterDisable = await call('GET', '/auth/me', null, analystToken);
  check(
    'disabled user session rejected',
    afterDisable.status === 401,
    JSON.stringify(afterDisable),
  );
  check(
    'disabled user cannot log in',
    (await login(inviteEmail, 'InviteePass789!')).status === 401,
  );

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
