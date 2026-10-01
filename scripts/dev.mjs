import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = process.argv[2] ?? 'dev';
let stopping = false;
let stoppedAt = 0;
let crashed = false;

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM') {
      return true;
    }
    throw error;
  }
};

const signalGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') {
      throw error;
    }
  }
};

const spawnApp = (app) => {
  const cwd = join(root, 'apps', app);
  const command = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts[script];
  const child = spawn('sh', ['-c', command], {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: [
        join(cwd, 'node_modules', '.bin'),
        join(root, 'node_modules', '.bin'),
        process.env.PATH,
      ].join(':'),
    },
  });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) =>
      process.stdout.write(`${app} | ${line}\n`),
    );
  }
  child.on('exit', () => {
    if (!stopping) {
      crashed = true;
      stop('SIGTERM');
    }
  });
  return child;
};

const backendListening = () =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 3000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const children = [spawnApp('backend')];

void (async () => {
  while (!stopping && !(await backendListening())) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stopping) {
    children.push(spawnApp('frontend'));
  }
})();

const stop = (signal) => {
  if (!stopping) {
    stopping = true;
    stoppedAt = Date.now();
    children.forEach((child) => signalGroup(child.pid, signal));
  } else if (Date.now() - stoppedAt > 1000) {
    children.forEach((child) => signalGroup(child.pid, 'SIGKILL'));
  }
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal));
}

setInterval(() => {
  if (
    children.every((child) => child.exitCode !== null || child.signalCode !== null) &&
    !children.some((child) => groupAlive(child.pid))
  ) {
    process.exit(crashed ? 1 : 0);
  }
}, 100);
