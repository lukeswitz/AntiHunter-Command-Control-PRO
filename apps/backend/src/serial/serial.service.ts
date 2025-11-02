import { create, toBinary } from '@bufbuild/protobuf';
import { Mesh, Portnums } from '@meshtastic/protobufs';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AutoDetectTypes } from '@serialport/bindings-cpp';
import * as SerialPortBindings from '@serialport/bindings-cpp';
import { ReadlineParser } from '@serialport/parser-readline';
import { SerialPortStream } from '@serialport/stream';
import PQueue from 'p-queue';
import { Observable, Subject } from 'rxjs';

import { createParser, ProtocolKey } from './protocol-registry';
import { DEFAULT_SERIAL_SITE_ID, SerialConfigService } from './serial-config.service';
import { SERIAL_DELIMITER_CANDIDATES } from './serial.config.defaults';
import { SerialParseResult, SerialProtocolParser } from './serial.types';
import { buildCommandPayload } from '../commands/command-builder';

const Binding = resolveBinding();

function resolveBinding(): AutoDetectTypes {
  const withNamedExport = (SerialPortBindings as { autoDetect?: () => AutoDetectTypes }).autoDetect;
  if (typeof withNamedExport === 'function') {
    return withNamedExport();
  }

  const withDefaultExport = (SerialPortBindings as { default?: () => AutoDetectTypes }).default;
  if (typeof withDefaultExport === 'function') {
    return withDefaultExport();
  }

  throw new Error('No serialport binding available for the current platform');
}

type SerialPortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
};

function isUdevadmMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as { code?: unknown; path?: unknown; spawnargs?: unknown[] };
  return err.code === 'ENOENT' && (err.path === 'udevadm' || err.spawnargs?.[0] === 'udevadm');
}

async function withGracefulUdevFallback(
  listFn: () => Promise<SerialPortInfo[]>,
): Promise<SerialPortInfo[] | null> {
  try {
    return await listFn();
  } catch (error) {
    if (isUdevadmMissing(error)) {
      console.warn(
        '[serial] udevadm not available in this environment; skipping hardware enumeration',
      );
      return [];
    }
    throw error;
  }
}

async function getAvailablePorts(): Promise<SerialPortInfo[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires,@typescript-eslint/no-unsafe-assignment
    const moduleRef: unknown = require('@serialport/list');
    const candidate =
      typeof moduleRef === 'function'
        ? moduleRef
        : moduleRef && typeof (moduleRef as { default?: unknown }).default === 'function'
          ? (moduleRef as { default: () => Promise<SerialPortInfo[]> }).default
          : moduleRef && typeof (moduleRef as { list?: unknown }).list === 'function'
            ? (moduleRef as { list: () => Promise<SerialPortInfo[]> }).list
            : null;
    if (candidate) {
      const ports = await withGracefulUdevFallback(() => candidate());
      if (ports) {
        return ports;
      }
    }
  } catch (error) {
    // ignore and fall back to binding-based listing
  }

  if ('list' in SerialPortStream) {
    const listFn = (SerialPortStream as unknown as { list: () => Promise<SerialPortInfo[]> }).list;
    const ports = await withGracefulUdevFallback(() => listFn());
    if (ports) {
      return ports;
    }
  }
  const bindingWithList = Binding as unknown as { list?: () => Promise<SerialPortInfo[]> };
  if (typeof bindingWithList.list === 'function') {
    const listFn = bindingWithList.list;
    const ports = await withGracefulUdevFallback(() => listFn());
    if (ports) {
      return ports;
    }
  }
  throw new Error('Serial port listing is not available on this platform.');
}

function normalizeDelimiter(value?: string | null): string {
  if (!value) {
    return '\n';
  }

  let normalized = value;

  if (normalized.includes('\\')) {
    normalized = normalized
      .replace(/\\r\\n/gi, '\r\n')
      .replace(/\\n/gi, '\n')
      .replace(/\\r/gi, '\r')
      .replace(/\\t/gi, '\t')
      .replace(/\\0/gi, '\0');
  }

  if (normalized.length === 0) {
    return '\n';
  }

  return normalized;
}

interface RateCounter {
  count: number;
  resetAt: number;
}

export interface QueueCommandRequest {
  id: string;
  target: string;
  name: string;
  params: string[];
  userId?: string;
  line?: string;
}

export interface SerialConnectionOptions {
  path?: string;
  baudRate: number;
  delimiter: string;
  protocol: ProtocolKey;
  rawDelimiter?: string;
  autoDetectDelimiter?: boolean;
  writeDelimiters: string[];
}

export interface SerialState {
  connected: boolean;
  path?: string;
  baudRate?: number;
  lastError?: string;
  protocol?: ProtocolKey;
}

@Injectable()
export class SerialService implements OnModuleInit, OnModuleDestroy {
  private port?: SerialPortStream;
  private lineParser?: ReadlineParser;
  private protocolParser: SerialProtocolParser = createParser('meshtastic-like');
  private readonly incoming$ = new Subject<string>();
  private readonly parsed$ = new Subject<SerialParseResult>();
  private readonly logger = new Logger(SerialService.name);
  private lastError?: string;
  private connectionOptions?: SerialConnectionOptions;
  private readonly commandQueue = new PQueue({ concurrency: 1 });
  private readonly globalRate: RateCounter = { count: 0, resetAt: 0 };
  private readonly targetRates = new Map<string, RateCounter>();
  private readonly globalRateLimit: number;
  private readonly perTargetRateLimit: number;
  private readonly rateWindowMs = 60_000;
  private siteId = DEFAULT_SERIAL_SITE_ID;
  private packetIdCounter = Math.floor(Math.random() * 0xffff);
  private readonly broadcastNum = 0xffffffff;

  constructor(
    private readonly configService: ConfigService,
    private readonly serialConfigService: SerialConfigService,
  ) {
    this.siteId = this.configService.get<string>('site.id', DEFAULT_SERIAL_SITE_ID);
    this.globalRateLimit = this.configService.get<number>('serial.globalRate', 30);
    this.perTargetRateLimit = this.configService.get<number>('serial.perTargetRate', 8);
  }

  async onModuleInit(): Promise<void> {
    try {
      const storedConfig = await this.serialConfigService.getConfig(this.siteId);
      this.siteId = storedConfig.siteId ?? DEFAULT_SERIAL_SITE_ID;

      if (storedConfig.enabled === false) {
        this.logger.log('Serial auto-connect disabled via configuration');
        return;
      }

      await this.connect({
        path: storedConfig.devicePath ?? this.configService.get<string>('serial.device'),
        baudRate: storedConfig.baud ?? this.configService.get<number>('serial.baudRate', 115200),
        delimiter:
          storedConfig.delimiter ?? this.configService.get<string>('serial.delimiter', '\n'),
        protocol: (this.configService.get<string>('serial.protocol', 'meshtastic-like') ??
          'meshtastic-like') as ProtocolKey,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error during serial auto-connect';
      if (error instanceof BadRequestException) {
        this.logger.log(`Serial auto-connect skipped: ${message}`);
      } else {
        this.logger.error(`Serial auto-connect failed: ${message}`);
      }
    }
  }

  onModuleDestroy(): void {
    void this.disconnect();
  }

  getIncomingStream(): Observable<string> {
    return this.incoming$.asObservable();
  }

  getParsedStream(): Observable<SerialParseResult> {
    return this.parsed$.asObservable();
  }

  getState(): SerialState {
    return {
      connected: Boolean(this.port),
      path: this.connectionOptions?.path ?? this.port?.path,
      baudRate: this.connectionOptions?.baudRate,
      lastError: this.lastError,
      protocol: this.connectionOptions?.protocol,
    };
  }

  getSiteId(): string {
    return this.siteId;
  }

  async listPorts(): Promise<SerialPortInfo[]> {
    return getAvailablePorts();
  }

  async connect(options?: Partial<SerialConnectionOptions>): Promise<void> {
    if (this.port) {
      this.logger.warn('Serial port already connected');
      return;
    }

    const baudRate = options?.baudRate ?? this.configService.get<number>('serial.baudRate', 115200);
    const requestedDelimiterRaw =
      options?.delimiter ?? this.configService.get<string>('serial.delimiter', '\n') ?? '\n';
    const delimiterToken = requestedDelimiterRaw.trim();
    const autoDetect = delimiterToken.toLowerCase() === 'auto';
    const delimiter = autoDetect ? '\n' : normalizeDelimiter(delimiterToken);
    const writeDelimiters = (
      autoDetect
        ? SERIAL_DELIMITER_CANDIDATES.map((candidate) => normalizeDelimiter(candidate))
        : [delimiter]
    ).filter((value, index, array) => array.indexOf(value) === index);
    const protocol = (options?.protocol ??
      this.configService.get<string>('serial.protocol', 'meshtastic-like') ??
      'meshtastic-like') as ProtocolKey;

    const candidatePaths = await this.buildCandidatePaths(options?.path);
    if (candidatePaths.length === 0) {
      throw new BadRequestException('No serial devices available to connect.');
    }

    this.packetIdCounter = Math.floor(Math.random() * 0xffff);

    let lastError: unknown;
    for (const candidatePath of candidatePaths) {
      try {
        await this.openPort(candidatePath, {
          baudRate,
          delimiter,
          protocol,
          writeDelimiters,
          autoDetectDelimiter: autoDetect,
          rawDelimiter: delimiterToken,
        });
        this.connectionOptions = {
          path: candidatePath,
          baudRate,
          delimiter,
          protocol,
          writeDelimiters,
          autoDetectDelimiter: autoDetect,
          rawDelimiter: delimiterToken,
        };
        await this.serialConfigService.updateConfig({
          siteId: this.siteId,
          devicePath: candidatePath,
          baud: baudRate,
          delimiter: delimiterToken,
          enabled: true,
        });
        this.logger.log(`Connected to serial port ${candidatePath}`);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `Failed to connect to serial port ${candidatePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (lastError instanceof Error) {
      throw new BadRequestException(lastError.message);
    }
    throw new BadRequestException('Unable to open any serial ports');
  }

  async disconnect(): Promise<void> {
    if (!this.port) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.port?.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.cleanup();
  }

  async queueCommand(request: QueueCommandRequest): Promise<void> {
    const built = buildCommandPayload({
      target: request.target,
      name: request.name,
      params: request.params,
    });
    const line = request.line ?? built.line;

    this.logger.debug(`Queueing command line: ${line}`);

    await this.commandQueue.add(async () => {
      this.ensureConnected();
      this.consumeRate(this.globalRate, this.globalRateLimit);
      this.consumeRate(this.getTargetCounter(built.target), this.perTargetRateLimit);
      const protocol = this.connectionOptions?.protocol ?? 'meshtastic-like';
      if (protocol === 'meshtastic-like') {
        await this.sendMeshtasticCommand(line);
      } else {
        await this.writeLine(line);
      }
    });
  }

  private cleanup(): void {
    if (this.lineParser) {
      this.lineParser.removeAllListeners();
      this.lineParser = undefined;
    }
    if (this.port) {
      this.port.removeAllListeners();
    }
    this.port = undefined;
    this.protocolParser.reset();
    this.connectionOptions = undefined;
    this.commandQueue.clear();
    this.globalRate.count = 0;
    this.globalRate.resetAt = 0;
    this.targetRates.clear();
    this.packetIdCounter = Math.floor(Math.random() * 0xffff);
  }

  private async writeBuffer(buffer: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const port = this.port;
      if (!port) {
        reject(new BadRequestException('Serial port is not connected'));
        return;
      }
      port.write(buffer, (err) => {
        if (err) {
          this.lastError = err.message;
          reject(err);
          return;
        }
        port.drain((drainErr) => {
          if (drainErr) {
            this.lastError = drainErr.message;
            reject(drainErr);
            return;
          }
          this.logger.debug(`Serial write completed (${buffer.length} bytes)`);
          resolve();
        });
      });
    });
  }

  private async writeLine(line: string): Promise<void> {
    this.ensureConnected();

    const writeDelimiters = this.connectionOptions?.writeDelimiters ?? [
      this.connectionOptions?.delimiter ?? '\n',
    ];
    const delimiter = writeDelimiters[0] ?? '\n';
    const payload = `${line}${delimiter}`;
    const buffer = Buffer.from(payload, 'utf8');

    this.logger.debug(
      {
        payload,
        hex: buffer.toString('hex'),
        delimiter: delimiter.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t'),
      },
      'Serial command payload',
    );

    await this.writeBuffer(buffer);
  }

  private async sendMeshtasticCommand(line: string): Promise<void> {
    this.ensureConnected();
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const channelConfig =
      this.configService.get<number>('serial.commandChannel') ??
      this.configService.get<number>('serial.sendChannel') ??
      0;
    const channelIndex = Number.isFinite(channelConfig) ? Number(channelConfig) : 0;

    const payload = Buffer.from(trimmed, 'utf8');
    const decoded = create(Mesh.DataSchema, {
      payload,
      portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
      wantResponse: false,
      dest: 0,
      source: 0,
      requestId: 0,
      replyId: 0,
    });

    const packet = create(Mesh.MeshPacketSchema, {
      id: this.nextPacketId(),
      to: this.broadcastNum,
      channel: channelIndex,
      wantAck: false,
      priority: Mesh.MeshPacket_Priority.RELIABLE,
      payloadVariant: {
        case: 'decoded',
        value: decoded,
      },
      hopLimit: 0,
    });

    const toRadio = create(Mesh.ToRadioSchema, {
      payloadVariant: {
        case: 'packet',
        value: packet,
      },
    });

    const binary = toBinary(Mesh.ToRadioSchema, toRadio);
    const payloadBytes = Buffer.from(binary);
    const frame = Buffer.alloc(4 + payloadBytes.length);
    frame[0] = 0x94;
    frame[1] = 0xc3;
    frame[2] = (payloadBytes.length >> 8) & 0xff;
    frame[3] = payloadBytes.length & 0xff;
    payloadBytes.copy(frame, 4);

    this.logger.debug(
      { payload: trimmed, channelIndex, frameHex: frame.toString('hex') },
      'Meshtastic frame payload',
    );

    await this.writeBuffer(frame);
  }

  private nextPacketId(): number {
    this.packetIdCounter = (this.packetIdCounter + 1) >>> 0;
    if (this.packetIdCounter === 0) {
      this.packetIdCounter = 1;
    }
    return this.packetIdCounter;
  }

  private ensureConnected(): void {
    if (!this.port) {
      throw new BadRequestException('Serial port is not connected');
    }
  }

  private consumeRate(counter: RateCounter, limit: number): void {
    const now = Date.now();
    if (now > counter.resetAt) {
      counter.count = 0;
      counter.resetAt = now + this.rateWindowMs;
    }

    if (counter.count >= limit) {
      throw new BadRequestException('Command rate limit exceeded');
    }

    counter.count += 1;
  }

  private getTargetCounter(target: string): RateCounter {
    const key = target || '@ALL';
    let counter = this.targetRates.get(key);
    if (!counter) {
      counter = { count: 0, resetAt: 0 };
      this.targetRates.set(key, counter);
    }
    return counter;
  }

  private async buildCandidatePaths(preferred?: string): Promise<string[]> {
    const ports = await getAvailablePorts();
    const candidates: string[] = [];

    if (preferred) {
      candidates.push(preferred);
    }

    const hints = ['meshtastic', 'cp210', 'ch34', 'silicon', 'usb serial', 'ttyusb', 'ttyacm'];
    const prioritized = ports
      .filter((port) => {
        const haystack = `${port.manufacturer ?? ''} ${port.productId ?? ''} ${
          port.vendorId ?? ''
        } ${port.path}`.toLowerCase();
        return hints.some((hint) => haystack.includes(hint));
      })
      .map((port) => port.path)
      .filter((path) => !candidates.includes(path));

    const others = ports
      .map((port) => port.path)
      .filter((path) => !candidates.includes(path) && !prioritized.includes(path));

    return [...candidates, ...prioritized, ...others];
  }

  private async openPort(
    path: string,
    options: {
      baudRate: number;
      delimiter: string;
      protocol: ProtocolKey;
      writeDelimiters: string[];
      autoDetectDelimiter: boolean;
      rawDelimiter?: string;
    },
  ): Promise<void> {
    this.logger.log(
      `Opening serial port ${path} @ ${options.baudRate} using protocol ${options.protocol}`,
    );

    try {
      this.port = new SerialPortStream({
        binding: Binding,
        path,
        baudRate: options.baudRate,
        autoOpen: true,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create serial port ${path}`, error as Error);
      throw error;
    }

    await new Promise<void>((resolve, reject) => {
      if (!this.port) {
        reject(new Error('Serial port not initialised'));
        return;
      }

      if (this.port.isOpen) {
        resolve();
        return;
      }

      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (err: Error) => {
        cleanup();
        this.lastError = err.message;
        reject(err);
      };
      const cleanup = () => {
        this.port?.off('open', handleOpen);
        this.port?.off('error', handleError);
      };

      this.port.once('open', handleOpen);
      this.port.once('error', handleError);
    });

    this.protocolParser = createParser(options.protocol);
    this.protocolParser.reset();

    const readDelimiter = options.autoDetectDelimiter ? '\n' : options.delimiter;
    this.lineParser = this.port.pipe(
      new ReadlineParser({
        delimiter: readDelimiter,
      }),
    );

    this.lineParser.on('data', (data: string | Buffer) => {
      const line = data
        .toString()
        .replace(/[\r\n]+$/, '')
        .trim();
      if (!line) {
        return;
      }
      this.logger.debug({ line }, 'Serial line received');
      this.incoming$.next(line);
      try {
        const parsed = this.protocolParser.parseLine(line);
        this.logger.debug({ parsed }, 'Parsed serial events');
        parsed.forEach((event) => this.parsed$.next(event));
      } catch (err) {
        this.logger.error(`Failed to parse serial line: ${line}`, err as Error);
        this.parsed$.next({ kind: 'raw', raw: line });
      }
    });

    this.lineParser.on('error', (err) => {
      this.logger.error(`Serial parser error: ${err.message}`, err.stack);
    });

    this.port.on('error', (err) => {
      this.lastError = err.message;
      this.logger.error(`Serial port error: ${err.message}`, err.stack);
    });

    this.port.on('close', () => {
      this.logger.warn('Serial port connection closed');
      this.cleanup();
    });
  }
}
