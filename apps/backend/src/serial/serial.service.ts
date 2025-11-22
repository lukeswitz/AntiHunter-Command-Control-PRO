import { create, toBinary } from '@bufbuild/protobuf';
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
import { randomUUID } from 'crypto';
import { Observable, Subject } from 'rxjs';

import { createParser, ProtocolKey } from './protocol-registry';
import {
  deserializeSerialParseResult,
  serializeSerialParseResult,
  SerialClusterMessage,
  SerialClusterRole,
  SerialRpcAction,
} from './serial-cluster.types';
import { SerialConfigService } from './serial-config.service';
import { SERIAL_DELIMITER_CANDIDATES } from './serial.config.defaults';
import { SerialConnectionOptions, SerialState } from './serial.interfaces';
import { SerialParseResult, SerialProtocolParser } from './serial.types';
import { buildCommandPayload } from '../commands/command-builder';

const Binding = resolveBinding();
const dynamicImport = new Function('specifier', 'return import(specifier);') as <TModule>(
  specifier: string,
) => Promise<TModule>;

type MeshProtoModule = typeof import('@meshtastic/protobufs');
let meshProtoModulePromise: Promise<MeshProtoModule> | null = null;

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

class AsyncQueue {
  private pending: Array<() => Promise<void>> = [];
  private active = false;

  add<T>(task: () => Promise<T>, priority = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const wrapped = async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      if (priority) {
        this.pending.unshift(wrapped);
      } else {
        this.pending.push(wrapped);
      }
      void this.process();
    });
  }

  clear(): void {
    this.pending = [];
  }

  private async process(): Promise<void> {
    if (this.active) {
      return;
    }
    this.active = true;
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) {
        continue;
      }
      try {
        await next();
      } catch {
        // Individual task already rejected; continue processing the queue.
      }
    }
    this.active = false;
    if (this.pending.length > 0) {
      void this.process();
    }
  }
}

async function loadMeshModule(): Promise<MeshProtoModule> {
  if (!meshProtoModulePromise) {
    meshProtoModulePromise = dynamicImport<MeshProtoModule>('@meshtastic/protobufs');
  }
  return meshProtoModulePromise;
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

@Injectable()
export class SerialService implements OnModuleInit, OnModuleDestroy {
  private port?: SerialPortStream;
  private lineParser?: ReadlineParser;
  private protocolParser: SerialProtocolParser = createParser('meshtastic-rewrite');
  private readonly incoming$ = new Subject<string>();
  private readonly parsed$ = new Subject<SerialParseResult>();
  private readonly logger = new Logger(SerialService.name);
  private lastError?: string;
  private connectionOptions?: SerialConnectionOptions;
  private readonly commandQueue = new AsyncQueue();
  private readonly globalRate: RateCounter = { count: 0, resetAt: 0 };
  private readonly targetRates = new Map<string, RateCounter>();
  private readonly globalRateLimit: number;
  private readonly perTargetRateLimit: number;
  private readonly rateWindowMs = 60_000;
  private siteId: string;
  private packetIdCounter = Math.floor(Math.random() * 0xffff);
  private readonly broadcastNum = 0xffffffff;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectJitter: number;
  private readonly reconnectMaxAttempts: number;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private manualDisconnect = false;
  private readonly clusterRole: SerialClusterRole;
  private readonly clusterMessagingEnabled: boolean;
  private readonly rpcTimeoutMs: number;
  private readonly pendingRpc = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private clusterMessageListener?: (message: unknown) => void;
  private replicaState: SerialState = { connected: false };

  constructor(
    private readonly configService: ConfigService,
    private readonly serialConfigService: SerialConfigService,
  ) {
    this.siteId = this.configService.get<string>('site.id', 'default');
    this.globalRateLimit = this.configService.get<number>('serial.globalRate', 30);
    this.perTargetRateLimit = this.configService.get<number>('serial.perTargetRate', 8);
    this.reconnectBaseMs = this.configService.get<number>('serial.reconnectBaseMs', 500);
    this.reconnectMaxMs = this.configService.get<number>('serial.reconnectMaxMs', 15_000);
    this.reconnectJitter = this.configService.get<number>('serial.reconnectJitter', 0.2);
    this.reconnectMaxAttempts =
      this.configService.get<number>('serial.reconnectMaxAttempts', 0) ?? 0;
    const configuredRole =
      (this.configService.get<string>('serial.clusterRole') as SerialClusterRole | undefined) ??
      'standalone';
    this.clusterRole =
      configuredRole === 'leader' || configuredRole === 'replica' ? configuredRole : 'standalone';
    this.clusterMessagingEnabled =
      this.clusterRole !== 'standalone' && typeof process.send === 'function';
    this.rpcTimeoutMs = this.configService.get<number>('serial.rpcTimeoutMs', 8000) ?? 8000;
  }

  async onModuleInit(): Promise<void> {
    this.setupClusterMessaging();
    if (this.clusterRole === 'replica') {
      this.logger.log(
        'Serial runtime running in replica mode; awaiting leader stream for parsed events.',
      );
      if (this.clusterMessagingEnabled) {
        await this.syncReplicaStateFromLeader().catch((error) => {
          this.logger.warn(
            `Initial serial state sync failed: ${error instanceof Error ? error.message : error}`,
          );
        });
      } else {
        this.logger.warn(
          'Replica role configured but cluster messaging unavailable; serial control endpoints will reject requests.',
        );
      }
      return;
    }

    await this.autoConnect().catch((error) => {
      this.handleAutoConnectFailure(error);
    });
    this.broadcastState();
  }

  onModuleDestroy(): void {
    if (this.clusterRole !== 'replica') {
      void this.disconnect();
    }
    this.teardownClusterMessaging();
  }

  private async autoConnect(): Promise<void> {
    const storedConfig = await this.serialConfigService.getConfig();
    if (storedConfig.enabled === false) {
      this.logger.log('Serial auto-connect disabled via configuration');
      return;
    }
    await this.connectInternal({
      path: storedConfig.devicePath ?? this.configService.get<string>('serial.device'),
      baudRate: storedConfig.baud ?? this.configService.get<number>('serial.baudRate', 115200),
      delimiter: storedConfig.delimiter ?? this.configService.get<string>('serial.delimiter', '\n'),
      protocol: (this.configService.get<string>('serial.protocol', 'meshtastic-rewrite') ??
        'meshtastic-rewrite') as ProtocolKey,
    });
  }

  private handleAutoConnectFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    if (error instanceof BadRequestException) {
      this.logger.log(`Serial auto-connect skipped: ${message}`);
    } else {
      this.logger.error(`Serial auto-connect failed: ${message}`);
    }
    this.lastError = message;
    this.broadcastState();
    this.scheduleReconnect(message);
  }

  getIncomingStream(): Observable<string> {
    return this.incoming$.asObservable();
  }

  getParsedStream(): Observable<SerialParseResult> {
    return this.parsed$.asObservable();
  }

  getState(): SerialState {
    if (this.clusterRole === 'replica') {
      return { ...this.replicaState };
    }
    return this.buildState();
  }

  private buildState(): SerialState {
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
    if (this.shouldUseRpc()) {
      const ports = await this.requestRpc('listPorts');
      return (ports as SerialPortInfo[]) ?? [];
    }
    return getAvailablePorts();
  }

  async connect(options?: Partial<SerialConnectionOptions>): Promise<void> {
    if (this.shouldUseRpc()) {
      const state = (await this.requestRpc('connect', options)) as SerialState | undefined;
      this.updateReplicaState(state);
      return;
    }
    await this.connectInternal(options);
    this.broadcastState();
  }

  async disconnect(): Promise<void> {
    if (this.shouldUseRpc()) {
      const state = (await this.requestRpc('disconnect')) as SerialState | undefined;
      this.updateReplicaState(state);
      return;
    }
    await this.performDisconnect();
    this.broadcastState();
  }

  async simulateLines(lines: string[]): Promise<void> {
    if (this.shouldUseRpc()) {
      await this.requestRpc('simulate', lines);
      return;
    }
    await this.simulateLinesInternal(lines);
  }

  private async connectInternal(options?: Partial<SerialConnectionOptions>): Promise<void> {
    if (this.port) {
      // Already connected in this process. If caller requests the same path (or no path), return silently.
      const requestedPath = options?.path?.trim();
      const currentPath = this.port.path ?? this.connectionOptions?.path;
      if (!requestedPath || requestedPath === currentPath) {
        this.logger.debug('Serial port already connected; returning existing connection state');
        return;
      }
      throw new BadRequestException(
        `Serial port already connected (${currentPath ?? 'unknown path'}). Disconnect first or restart backend.`,
      );
    }

    this.clearReconnectTimer();
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
      this.configService.get<string>('serial.protocol', 'meshtastic-rewrite') ??
      'meshtastic-rewrite') as ProtocolKey;

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
          devicePath: candidatePath,
          baud: baudRate,
          delimiter: delimiterToken,
          enabled: true,
        });
        this.logger.log(`Connected to serial port ${candidatePath}`);
        this.lastError = undefined;
        this.reconnectAttempts = 0;
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

  private async performDisconnect(): Promise<void> {
    const port = this.port;
    if (!port) {
      return;
    }

    this.manualDisconnect = true;
    this.clearReconnectTimer();
    const isOpen =
      typeof (port as SerialPortStream & { isOpen?: boolean }).isOpen === 'boolean'
        ? (port as SerialPortStream & { isOpen?: boolean }).isOpen
        : true;
    if (!isOpen) {
      this.cleanup();
      this.manualDisconnect = false;
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        port.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    } finally {
      this.cleanup();
      this.manualDisconnect = false;
    }
  }

  async queueCommand(request: QueueCommandRequest): Promise<void> {
    if (this.shouldUseRpc()) {
      await this.requestRpc('queueCommand', request);
      return;
    }
    await this.queueCommandInternal(request);
  }

  private async queueCommandInternal(request: QueueCommandRequest): Promise<void> {
    const built = buildCommandPayload({
      target: request.target,
      name: request.name,
      params: request.params,
    });
    const line = request.line ?? built.line;

    this.logger.debug(`Queueing command line: ${line}`);

    const isStopCommand = built.name === 'STOP';
    if (isStopCommand) {
      this.logger.warn('STOP command requested; clearing pending command queue');
      this.commandQueue.clear();
    }

    await this.commandQueue.add(async () => {
      this.ensureConnected();
      this.logger.debug({
        writeProtocol: this.connectionOptions?.protocol,
        writePort: this.connectionOptions?.path,
        writeBaud: this.connectionOptions?.baudRate,
        writeOpen: this.port?.isOpen ?? false,
      });
      if (!isStopCommand) {
        this.consumeRate(this.globalRate, this.globalRateLimit);
        this.consumeRate(this.getTargetCounter(built.target), this.perTargetRateLimit);
      }
      const protocol = this.connectionOptions?.protocol ?? 'meshtastic-rewrite';
      const sendMode =
        this.configService.get<string>('serial.sendMode')?.toLowerCase() ?? 'protobuf';
      const hopLimit = this.configService.get<number>('serial.hopLimit');

      if (protocol === 'meshtastic-rewrite') {
        if (sendMode === 'plain') {
          await this.writeLine(line);
          return;
        }

        const wantAck = sendMode === 'protobuf-ack';
        await this.sendMeshtasticCommand(line, {
          wantAck,
          hopLimit: Number.isFinite(hopLimit) ? (hopLimit as number) : undefined,
        });
      } else {
        await this.writeLine(line);
      }
    }, isStopCommand);
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
    this.broadcastState();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.manualDisconnect) {
      return;
    }
    if (this.reconnectMaxAttempts > 0 && this.reconnectAttempts >= this.reconnectMaxAttempts) {
      this.logger.warn(
        `Serial reconnect skipped: maximum attempts (${this.reconnectMaxAttempts}) reached`,
      );
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    if (this.reconnectBaseMs <= 0) {
      return;
    }
    const nextAttempt = this.reconnectAttempts + 1;
    const exponentialDelay = this.reconnectBaseMs * Math.pow(2, nextAttempt - 1);
    const cappedDelay =
      this.reconnectMaxMs > 0 ? Math.min(exponentialDelay, this.reconnectMaxMs) : exponentialDelay;
    const jitterRange = cappedDelay * this.reconnectJitter;
    const jitter = jitterRange ? (Math.random() * 2 - 1) * jitterRange : 0;
    const delay = Math.max(250, Math.round(cappedDelay + jitter));
    this.logger.warn(
      `Serial reconnect scheduled in ${delay}ms (attempt ${nextAttempt}${
        reason ? `, reason: ${reason}` : ''
      })`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectAttempts = nextAttempt;
      this.autoConnect().catch((error) => this.handleAutoConnectFailure(error));
    }, delay);
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
        let settled = false;
        const cleanup = () => {
          settled = true;
        };
        const timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          cleanup();
          this.logger.warn('Serial drain timed out; assuming write completed');
          resolve();
        }, 1000);
        port.drain((drainErr) => {
          if (settled) {
            return;
          }
          clearTimeout(timeout);
          cleanup();
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

  private async sendMeshtasticCommand(
    line: string,
    options?: { wantAck?: boolean; hopLimit?: number },
  ): Promise<void> {
    this.ensureConnected();
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const { Mesh, Portnums } = await loadMeshModule();

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
      wantAck: options?.wantAck ?? false,
      priority: Mesh.MeshPacket_Priority.RELIABLE,
      payloadVariant: {
        case: 'decoded',
        value: decoded,
      },
      hopLimit:
        Number.isFinite(options?.hopLimit) && (options?.hopLimit as number) > 0
          ? (options?.hopLimit as number)
          : 3,
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
      this.processIncomingLine(line, 'serial');
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
      if (!this.manualDisconnect) {
        this.scheduleReconnect('port closed');
      }
    });
  }

  private async simulateLinesInternal(lines: string[]): Promise<void> {
    for (const rawLine of lines) {
      const line = rawLine.replace(/[\r\n]+$/g, '').trim();
      if (line) {
        this.processIncomingLine(line, 'simulation');
      }
      await delay(50);
    }
  }

  private shouldUseRpc(): boolean {
    return this.clusterRole === 'replica' && this.clusterMessagingEnabled;
  }

  private setupClusterMessaging(): void {
    if (!this.clusterMessagingEnabled || this.clusterMessageListener) {
      return;
    }
    const listener = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') {
        return;
      }
      const envelope = raw as SerialClusterMessage;
      if (envelope.channel !== 'serial') {
        return;
      }
      this.handleClusterMessage(envelope);
    };

    process.on('message', listener as (message: unknown) => void);
    this.clusterMessageListener = listener as (message: unknown) => void;
    if (this.clusterRole === 'leader') {
      this.broadcastState();
    }
  }

  private teardownClusterMessaging(): void {
    if (this.clusterMessageListener) {
      const remover = (process.off ?? process.removeListener).bind(process);
      remover('message', this.clusterMessageListener);
      this.clusterMessageListener = undefined;
    }
    for (const [requestId, pending] of this.pendingRpc.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Serial service shutting down'));
      this.pendingRpc.delete(requestId);
    }
  }

  private async syncReplicaStateFromLeader(): Promise<void> {
    if (!this.shouldUseRpc()) {
      this.replicaState = { connected: false };
      return;
    }
    const state = (await this.requestRpc('getState')) as SerialState | undefined;
    this.updateReplicaState(state);
  }

  private updateReplicaState(state?: SerialState): void {
    if (!state) {
      return;
    }
    this.replicaState = { ...state };
    this.lastError = state.lastError;
  }

  private handleClusterMessage(message: SerialClusterMessage): void {
    switch (message.type) {
      case 'event':
        if (this.clusterRole !== 'replica' || !Array.isArray(message.events)) {
          return;
        }
        message.events.forEach((payload) => {
          const event = deserializeSerialParseResult(payload);
          this.parsed$.next(event);
        });
        break;
      case 'state':
        if (this.clusterRole !== 'replica' || !message.state) {
          return;
        }
        this.updateReplicaState(message.state);
        break;
      case 'rpc-response': {
        const requestId = message.requestId;
        if (!requestId) {
          return;
        }
        const pending = this.pendingRpc.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRpc.delete(requestId);
        if (message.success === false) {
          pending.reject(new Error(message.error ?? 'Serial RPC failed'));
        } else {
          pending.resolve(message.payload);
        }
        break;
      }
      case 'rpc-request':
        if (
          this.clusterRole !== 'leader' ||
          !message.requestId ||
          !message.action ||
          typeof message.sourceId !== 'number'
        ) {
          return;
        }
        void this.handleRpcRequest(
          message.requestId,
          message.action,
          message.payload,
          message.sourceId,
        );
        break;
      default:
        break;
    }
  }

  private async requestRpc<T = unknown>(action: SerialRpcAction, payload?: unknown): Promise<T> {
    if (!this.clusterMessagingEnabled || typeof process.send !== 'function') {
      throw new Error('Serial RPC is not available in this process');
    }
    const requestId = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(requestId);
        reject(new Error(`Serial RPC "${action}" timed out`));
      }, this.rpcTimeoutMs);
      const wrappedResolve = (value: unknown) => resolve(value as T);
      const wrappedReject = (reason?: unknown) => reject(reason);
      this.pendingRpc.set(requestId, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        timeout,
      });
      const envelope: SerialClusterMessage = {
        channel: 'serial',
        type: 'rpc-request',
        requestId,
        action,
        payload,
      };
      try {
        process.send?.(envelope);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRpc.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleRpcRequest(
    requestId: string,
    action: SerialRpcAction,
    payload: unknown,
    sourceId: number,
  ): Promise<void> {
    try {
      let result: unknown;
      switch (action) {
        case 'connect':
          await this.connectInternal(payload as Partial<SerialConnectionOptions>);
          this.broadcastState();
          result = this.buildState();
          break;
        case 'disconnect':
          await this.performDisconnect();
          this.broadcastState();
          result = this.buildState();
          break;
        case 'listPorts':
          result = await getAvailablePorts();
          break;
        case 'simulate':
          await this.simulateLinesInternal((payload as string[]) ?? []);
          result = true;
          break;
        case 'getState':
          result = this.buildState();
          break;
        case 'queueCommand':
          await this.queueCommandInternal(payload as QueueCommandRequest);
          result = true;
          break;
        default:
          throw new Error(`Unsupported serial RPC action: ${action}`);
      }
      this.sendRpcResponse(requestId, sourceId, true, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendRpcResponse(requestId, sourceId, false, undefined, message);
    }
  }

  private sendRpcResponse(
    requestId: string,
    targetId: number,
    success: boolean,
    payload?: unknown,
    error?: string,
  ): void {
    if (!this.clusterMessagingEnabled || typeof process.send !== 'function') {
      return;
    }
    const envelope: SerialClusterMessage = {
      channel: 'serial',
      type: 'rpc-response',
      requestId,
      success,
      payload,
      error,
      targetId,
    };
    try {
      process.send?.(envelope);
    } catch (err) {
      this.logger.warn(
        `Failed to send serial RPC response: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private broadcastParsedEvents(events: SerialParseResult[]): void {
    if (
      !events.length ||
      this.clusterRole !== 'leader' ||
      !this.clusterMessagingEnabled ||
      typeof process.send !== 'function'
    ) {
      return;
    }
    const envelope: SerialClusterMessage = {
      channel: 'serial',
      type: 'event',
      events: events.map((event) => serializeSerialParseResult(event)),
    };
    try {
      process.send?.(envelope);
    } catch (error) {
      this.logger.debug(
        `Failed to broadcast serial events: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private broadcastState(): void {
    if (
      this.clusterRole !== 'leader' ||
      !this.clusterMessagingEnabled ||
      typeof process.send !== 'function'
    ) {
      return;
    }
    const envelope: SerialClusterMessage = {
      channel: 'serial',
      type: 'state',
      state: this.buildState(),
    };
    try {
      process.send?.(envelope);
    } catch (error) {
      this.logger.debug(
        `Failed to broadcast serial state: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private processIncomingLine(line: string, source: 'serial' | 'simulation'): void {
    const sanitized = sanitizeLine(line);
    if (!sanitized) {
      return;
    }
    // Some devices bundle multiple payloads in one line separated by CR/LF.
    const parts = sanitized
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      this.logger.debug(
        { line: part },
        source === 'serial' ? 'Serial line received' : 'Simulated serial line',
      );
      const lower = part.toLowerCase();
      // Skip router debug lines that mirror the payload as "msg=..." to avoid duplicate parsing.
      if (lower.includes('msg=')) {
        this.parsed$.next({ kind: 'raw', raw: part });
        continue;
      }
      this.incoming$.next(part);
      try {
        const msgIndex = part.toLowerCase().indexOf('msg=');
        const parseCandidate = msgIndex >= 0 ? part.slice(msgIndex + 4).trim() : part;
        const parsed = this.protocolParser.parseLine(parseCandidate || part);
        if (!parsed.length) {
          this.logger.debug({ line: part }, 'Serial line ignored by parser');
          continue;
        }
        this.logger.debug({ parsed }, 'Parsed serial events');
        parsed.forEach((event) => this.parsed$.next(event));
        this.broadcastParsedEvents(parsed);
      } catch (err) {
        this.logger.error(`Failed to parse ${source} line: ${part}`, err as Error);
        this.parsed$.next({ kind: 'raw', raw: part });
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLine(value: string): string {
  // Strip BOM and control characters except standard whitespace.
  let cleaned = value.replace(/\uFEFF/g, '');
  cleaned = Array.from(cleaned)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20;
    })
    .join('');

  // Remove leading non-printable/garbage prefixes before the first useful token.
  const firstUseful = cleaned.search(/[A-Za-z0-9@]/);
  if (firstUseful > 0) {
    cleaned = cleaned.slice(firstUseful);
  }

  // Remove placeholder Fahrenheit fragments like "/undefinedF" or "undefinedF".
  cleaned = cleaned.replace(/\/?undefinedf\b/gi, '');

  // Strip stray Unicode replacement characters so prefixes like "0? :" don't block parsing.
  cleaned = cleaned.replace(/\uFFFD/g, '');

  // Drop leading channel/slot markers like "1 :" or "10:" that some devices prepend.
  const channelMarker = /^\s*\d+\s*:\s*(.+)$/;
  const markerMatch = channelMarker.exec(cleaned);
  if (markerMatch?.[1]) {
    cleaned = markerMatch[1];
  } else {
    // Some firmwares prefix text frames with a single-letter marker like "C :" or "P :". Strip it.
    const alphaMarker = /^\s*[A-Za-z]\s*:\s*(.+)$/;
    const alphaMatch = alphaMarker.exec(cleaned);
    if (alphaMatch?.[1]) {
      cleaned = alphaMatch[1];
    }
  }

  // Drop any leftover leading symbols/punctuation before the actual node/text payload.
  cleaned = cleaned.replace(/^[^A-Za-z0-9@]+/, '');

  // Remove router hop prefixes like "0c58:" that precede the real node id.
  const routerHop = /^\s*[0-9a-f]{4}:\s+(.+)$/i;
  const hopMatch = routerHop.exec(cleaned);
  if (hopMatch?.[1]) {
    cleaned = hopMatch[1];
  }

  // Remove ANSI color/control codes.
  cleaned = stripAnsi(cleaned);

  return cleaned.trim();
}

function stripAnsi(value: string): string {
  // Remove ANSI escape sequences (color codes, etc.).
  let result = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === '\u001b' && value[i + 1] === '[') {
      // Skip until we hit a letter (ANSI terminator)
      i += 2;
      while (i < value.length && !/[A-Za-z]/.test(value[i])) {
        i += 1;
      }
      i += 1; // consume the terminator
    } else {
      result += value[i];
      i += 1;
    }
  }
  return result;
}
