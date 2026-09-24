import { BadRequestException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RemoteAlertConfig } from '@prisma/client';
import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { RemoteAlertConfigService } from './remote-alert-config.service';

const VERSION = '0.14.8';
const ASSET = `signal-cli-${VERSION}-Linux-native.tar.gz`;
const DOWNLOAD_URL = `https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/${ASSET}`;
const SHA256 = '36569af20c709e0c5e6e677b74f50f147b21f3740620b8a7affde70f6027f82a';
const SIZE = 113821552;
const LATEST_URL = 'https://api.github.com/repos/AsamK/signal-cli/releases/latest';
const SIGNAL_CONTAINER = 'cc_signal';

@Injectable()
export class SignalConnectorService implements OnModuleDestroy {
  private readonly logger = new Logger(SignalConnectorService.name);
  private readonly home =
    process.env.AHCC_SIGNAL_HOME?.trim() || join(process.cwd(), '.signal-cli');
  private readonly binPath = join(this.home, `signal-cli-${VERSION}`, 'signal-cli');
  private readonly configDir = join(this.home, 'account');
  private acquisition: Promise<void> | null = null;
  private linkChild: ChildProcess | null = null;
  private lastLinkUri: string | null = null;

  constructor(private readonly config: RemoteAlertConfigService) {}

  async onModuleDestroy(): Promise<void> {
    this.linkChild?.kill('SIGTERM');
  }

  usesNative(config: RemoteAlertConfig): boolean {
    return !config.signalApiUrl?.trim();
  }

  isSupported(): boolean {
    return process.platform === 'linux' && process.arch === 'x64';
  }

  usesNativeCli(config: RemoteAlertConfig): boolean {
    return this.usesNative(config) && this.isSupported();
  }

  async binaryReady(): Promise<boolean> {
    try {
      await stat(this.binPath);
      return true;
    } catch {
      return false;
    }
  }

  async checkUpdate(): Promise<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
  }> {
    try {
      const response = await fetch(LATEST_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return { current: VERSION, latest: null, updateAvailable: false };
      }
      const body = (await response.json()) as { tag_name?: unknown };
      const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null;
      return { current: VERSION, latest, updateAvailable: Boolean(latest && latest !== VERSION) };
    } catch {
      return { current: VERSION, latest: null, updateAvailable: false };
    }
  }

  private which(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  async setupHint(): Promise<{
    platform: string;
    arch: string;
    supported: boolean;
    steps: Array<{ text: string; cmd?: string; url?: string }>;
    controls: { start: string; stop: string; restart: string } | null;
  }> {
    const platform = process.platform;
    const arch = process.arch;
    const supported = this.isSupported();
    if (supported) {
      return {
        platform,
        arch,
        supported,
        steps: [{ text: 'AHCC installs and runs signal-cli itself. Click Link Signal.' }],
        controls: null,
      };
    }
    const [dockerFound, colimaFound] = await Promise.all([
      this.which('docker'),
      this.which('colima'),
    ]);
    const steps: Array<{ text: string; cmd?: string; url?: string }> = [];
    if (!dockerFound) {
      steps.push({ text: 'Install Docker', url: 'https://docs.docker.com/get-docker/' });
    } else if (colimaFound) {
      steps.push({ text: 'Start the Docker VM', cmd: 'colima start' });
    }
    const startCmd = `docker start ${SIGNAL_CONTAINER} 2>/dev/null || docker run -d --name ${SIGNAL_CONTAINER} -p 127.0.0.1:8079:8080 -e MODE=native -v ${SIGNAL_CONTAINER}:/home/.local/share/signal-cli bbernhard/signal-cli-rest-api`;
    steps.push({
      text: 'Start the Signal connector on loopback (creates it the first time, starts it after)',
      cmd: startCmd,
    });
    steps.push({
      text: 'That is all — AHCC detects it on 127.0.0.1:8079 and shows Link Signal automatically.',
    });
    return {
      platform,
      arch,
      supported,
      steps,
      controls: {
        start: startCmd,
        stop: `docker stop ${SIGNAL_CONTAINER}`,
        restart: `docker restart ${SIGNAL_CONTAINER}`,
      },
    };
  }

  private async ensureReady(): Promise<void> {
    if (await this.binaryReady()) {
      return;
    }
    if (!this.isSupported()) {
      throw new BadRequestException(
        `AHCC can only auto-run signal-cli on x86_64 Linux (this host is ${process.platform}/${process.arch}). Use the Docker signal profile instead.`,
      );
    }
    this.acquisition ??= this.acquire().finally(() => {
      this.acquisition = null;
    });
    return this.acquisition;
  }

  private async acquire(): Promise<void> {
    await mkdir(join(this.home, `signal-cli-${VERSION}`), { recursive: true, mode: 0o700 });
    const tmp = join(this.home, `download-${process.pid}.tar.gz`);
    this.logger.log(`Downloading signal-cli ${VERSION} (${SIZE} bytes)`);
    const response = await fetch(DOWNLOAD_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || !response.body) {
      throw new BadRequestException(`signal-cli download failed (${response.status})`);
    }
    const hash = createHash('sha256');
    let size = 0;
    const source = Readable.fromWeb(response.body as never);
    source.on('data', (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    try {
      await pipeline(source, createWriteStream(tmp, { mode: 0o600 }));
      if (size !== SIZE) {
        throw new BadRequestException(`signal-cli download size mismatch (${size} != ${SIZE})`);
      }
      if (hash.digest('hex') !== SHA256) {
        throw new BadRequestException('signal-cli download failed integrity check');
      }
      await this.extract(tmp);
      await chmod(this.binPath, 0o700);
      this.logger.log('signal-cli verified and installed');
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private extract(archive: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'tar',
        ['-xzf', archive, '-C', join(this.home, `signal-cli-${VERSION}`)],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)),
      );
    });
  }

  private run(args: string[], timeoutMs = 30_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binPath, ['--config', this.configDir, ...args], {
        env: { PATH: process.env.PATH, HOME: this.home, TMPDIR: process.env.TMPDIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(`signal-cli ${args[0]} exited ${code}: ${stderr.trim() || stdout.trim()}`),
          );
        }
      });
    });
  }

  async linkUri(): Promise<string> {
    await this.ensureReady();
    if (this.linkChild && this.lastLinkUri) {
      return this.lastLinkUri;
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.binPath, ['--config', this.configDir, 'link', '-n', 'AntiHunter'], {
        env: { PATH: process.env.PATH, HOME: this.home, TMPDIR: process.env.TMPDIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.linkChild = child;
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
          reject(new BadRequestException('signal-cli did not return a link code in time'));
        }
      }, 45_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(/sgnl:\/\/linkdevice\?\S+/);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          this.lastLinkUri = match[0];
          resolve(match[0]);
        }
      });
      child.on('error', (error) => {
        if (!settled) {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on('exit', (code) => {
        this.linkChild = null;
        this.lastLinkUri = null;
        if (code === 0) {
          void this.onLinked();
        } else if (!settled) {
          clearTimeout(timer);
          reject(new Error(`signal-cli link exited ${code}`));
        }
      });
    });
  }

  private async onLinked(): Promise<void> {
    const number = await this.linkedNumber();
    if (number) {
      await this.config.update({ signalNumber: number, signalEnabled: true });
      this.logger.log('Signal device linked');
    }
  }

  async linkedNumber(): Promise<string | null> {
    if (!(await this.binaryReady())) {
      return null;
    }
    try {
      const out = await this.run(['--output', 'json', 'listAccounts'], 10_000);
      const accounts = JSON.parse(out) as Array<{ number?: unknown }>;
      const first = accounts.find((account) => typeof account.number === 'string');
      return first ? (first.number as string) : null;
    } catch {
      return null;
    }
  }

  async createGroup(): Promise<string> {
    await this.ensureReady();
    const out = await this.run([
      '--output',
      'json',
      'updateGroup',
      '-n',
      'AntiHunter Alerts',
      '--set-permission-add-member',
      'only-admins',
      '--set-permission-edit-details',
      'only-admins',
      '--link',
      'disabled',
    ]);
    const body = JSON.parse(out) as { groupId?: unknown };
    if (typeof body.groupId !== 'string') {
      throw new Error('signal-cli did not return a group id');
    }
    return body.groupId;
  }

  async send(groupId: string, message: string): Promise<void> {
    await this.ensureReady();
    await this.run(['send', '-g', groupId, '-m', message]);
  }
}
