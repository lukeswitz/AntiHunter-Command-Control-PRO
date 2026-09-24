import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { RemoteAlertConfigService } from './remote-alert-config.service';

const PORT = Number(process.env.AHCC_SIGNAL_PORT) || 8079;
const HOST = '127.0.0.1';

function resolveBinary(): string | null {
  const configured = process.env.AHCC_SIGNAL_BIN?.trim();
  if (configured) {
    return existsSync(configured) ? configured : null;
  }
  const names = ['signal-cli-rest-api', 'signal-api'];
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

@Injectable()
export class SignalConnectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignalConnectorService.name);
  private child: ChildProcess | null = null;
  private stopping = false;
  private lastExit: string | null = null;
  private readonly binary = resolveBinary();

  constructor(private readonly config: RemoteAlertConfigService) {}

  /** URL AHCC (via the proxy) should target when AHCC manages the connector. */
  static managedUrl(): string {
    return `http://${HOST}:${PORT}`;
  }

  isManaged(): boolean {
    return Boolean(this.binary);
  }

  status(): { managed: boolean; running: boolean; binary: string | null; lastExit: string | null } {
    return {
      managed: this.isManaged(),
      running: Boolean(this.child),
      binary: this.binary,
      lastExit: this.lastExit,
    };
  }

  async onModuleInit(): Promise<void> {
    this.config.onChange(() => void this.sync());
    await this.sync();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async sync(): Promise<void> {
    const { signalEnabled } = await this.config.get();
    if (signalEnabled && this.binary && !this.child) {
      this.start();
    } else if ((!signalEnabled || !this.binary) && this.child) {
      await this.stop();
    }
  }

  private start(): void {
    if (!this.binary) {
      return;
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      MODE: 'native',
      PORT: String(PORT),
      SIGNAL_CLI_CONFIG:
        process.env.AHCC_SIGNAL_CONFIG?.trim() || join(process.cwd(), '.signal-cli'),
    };
    const child = spawn(this.binary, [], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    this.child = child;
    this.stopping = false;
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
      }
      this.lastExit = `code ${code}, signal ${signal}, at ${new Date().toISOString()}`;
      if (!this.stopping) {
        this.logger.error(`Signal connector exited (${this.lastExit})`);
      }
    });
    child.on('error', (error) => this.logger.error(`Signal connector error: ${error.message}`));
    this.logger.log(`Signal connector started: ${this.binary} on ${HOST}:${PORT}`);
  }

  private async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.stopping = true;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8_000);
    await exited;
    clearTimeout(timeout);
    this.child = null;
  }
}
