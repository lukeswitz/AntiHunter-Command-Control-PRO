import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandLog, CommandStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Observable, Subject } from 'rxjs';

import { buildCommandPayload } from './command-builder';
import { PrismaService } from '../prisma/prisma.service';
import { SerialService } from '../serial/serial.service';
import { SerialCommandAck, SerialCommandResult } from '../serial/serial.types';
import { SendCommandDto } from './dto/send-command.dto';

const ACK_TO_COMMAND: Record<string, string> = {
  SCAN_ACK: 'SCAN_START',
  DEVICE_SCAN_ACK: 'DEVICE_SCAN_START',
  DRONE_ACK: 'DRONE_START',
  DEAUTH_ACK: 'DEAUTH_START',
  RANDOMIZATION_ACK: 'RANDOMIZATION_START',
  BASELINE_ACK: 'BASELINE_START',
  TRIANGULATE_ACK: 'TRIANGULATE_START',
  TRIANGULATE_STOP_ACK: 'TRIANGULATE_STOP',
  ERASE_ACK: 'ERASE_FORCE',
  CHANNELS_ACK: 'CONFIG_CHANNELS',
  TARGETS_ACK: 'CONFIG_TARGETS',
};

export interface CommandState {
  id: string;
  siteId?: string | null;
  target: string;
  name: string;
  params: string[];
  status: CommandStatus;
  userId?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  ackKind?: string | null;
  ackStatus?: string | null;
  ackNode?: string | null;
  resultText?: string | null;
  errorText?: string | null;
}

export interface RemoteCommandRequest {
  id: string;
  siteId: string;
  target: string;
  name: string;
  params: string[];
  line: string;
  userId?: string | null;
}

export interface ExternalCommandEventInput {
  id: string;
  siteId: string;
  target: string;
  name: string;
  params: string[];
  status: string;
  userId?: string | null;
  ackKind?: string | null;
  ackStatus?: string | null;
  ackNode?: string | null;
  resultText?: string | null;
  errorText?: string | null;
  createdAt?: string | Date;
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
}

@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);
  private readonly updates$ = new Subject<CommandState>();
  private readonly remoteRequests$ = new Subject<RemoteCommandRequest>();
  private readonly localSiteId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly serialService: SerialService,
    configService: ConfigService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
  }

  getUpdatesStream(): Observable<CommandState> {
    return this.updates$.asObservable();
  }

  getRemoteRequestsStream(): Observable<RemoteCommandRequest> {
    return this.remoteRequests$.asObservable();
  }

  async sendCommand(dto: SendCommandDto, userId?: string): Promise<CommandState> {
    const commandId = randomUUID();
    const targetSiteId =
      dto.siteId && dto.siteId.trim().length > 0 ? dto.siteId.trim() : this.localSiteId;
    const built = buildCommandPayload({
      target: dto.target,
      name: dto.name,
      params: dto.params,
    });

    const command = await this.prisma.commandLog.create({
      data: {
        id: commandId,
        siteId: targetSiteId,
        userId,
        target: built.target,
        name: built.name,
        params: built.params,
        status: 'PENDING',
      },
    });

    this.emitUpdate(command);

    if (targetSiteId !== this.localSiteId) {
      this.remoteRequests$.next({
        id: commandId,
        siteId: targetSiteId,
        target: built.target,
        name: built.name,
        params: built.params,
        line: built.line,
        userId,
      });
      return this.mapCommand(command);
    }

    try {
      await this.serialService.queueCommand({
        id: commandId,
        target: built.target,
        name: built.name,
        params: built.params,
        line: built.line,
        userId,
      });

      const updated = await this.prisma.commandLog.update({
        where: { id: commandId },
        data: {
          status: 'SENT',
          startedAt: new Date(),
        },
      });

      this.emitUpdate(updated);
      return this.mapCommand(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.prisma.commandLog.update({
        where: { id: commandId },
        data: {
          status: 'ERROR',
          errorText: message,
          finishedAt: new Date(),
        },
      });
      this.emitUpdate(failed);
      throw error;
    }
  }

  async findById(id: string): Promise<CommandState> {
    const command = await this.prisma.commandLog.findUnique({ where: { id } });
    if (!command) {
      throw new NotFoundException(`Command ${id} not found`);
    }
    return this.mapCommand(command);
  }

  async handleAck(ack: SerialCommandAck): Promise<void> {
    const commandName = this.mapAckTypeToCommand(ack.ackType);
    if (!commandName) {
      return;
    }

    const command = await this.findLatestMatchingCommand(commandName, ack.nodeId);
    if (!command) {
      return;
    }

    const status = this.deriveStatusFromAck(ack.status, command.status);
    const finishedAt =
      status === 'OK' || status === 'ERROR' ? new Date() : (command.finishedAt ?? undefined);

    const updated = await this.prisma.commandLog.update({
      where: { id: command.id },
      data: {
        ackKind: ack.ackType,
        ackStatus: ack.status,
        ackNode: ack.nodeId,
        status,
        finishedAt,
        errorText: status === 'ERROR' ? ack.raw : command.errorText,
      },
    });

    this.emitUpdate(updated);
  }

  async handleResult(result: SerialCommandResult): Promise<void> {
    const command = await this.findLatestMatchingCommand(result.command, result.nodeId);
    if (!command) {
      return;
    }

    const updated = await this.prisma.commandLog.update({
      where: { id: command.id },
      data: {
        resultText: result.payload,
        status: 'OK',
        finishedAt: new Date(),
      },
    });

    this.emitUpdate(updated);
  }

  private emitUpdate(command: CommandLog): void {
    this.updates$.next(this.mapCommand(command));
  }

  async syncExternalCommand(event: ExternalCommandEventInput): Promise<CommandState> {
    const siteId =
      event.siteId && event.siteId.trim().length > 0 ? event.siteId.trim() : this.localSiteId;
    const status = this.normalizeStatus(event.status);

    const createdAt = event.createdAt ? new Date(event.createdAt) : new Date();
    const startedAt = event.startedAt ? new Date(event.startedAt) : null;
    const finishedAt = event.finishedAt ? new Date(event.finishedAt) : null;

    const baseData = {
      siteId,
      target: event.target,
      name: event.name,
      params: event.params,
      status,
      userId: event.userId ?? null,
      ackKind: event.ackKind ?? null,
      ackStatus: event.ackStatus ?? null,
      ackNode: event.ackNode ?? null,
      resultText: event.resultText ?? null,
      errorText: event.errorText ?? null,
      createdAt,
      startedAt,
      finishedAt,
    };

    let record: CommandLog;
    const existing = await this.prisma.commandLog.findUnique({ where: { id: event.id } });

    if (existing) {
      record = await this.prisma.commandLog.update({
        where: { id: event.id },
        data: {
          ...baseData,
        },
      });
    } else {
      record = await this.prisma.commandLog.create({
        data: {
          id: event.id,
          ...baseData,
        },
      });
    }

    this.emitUpdate(record);
    return this.mapCommand(record);
  }

  async executeRemoteRequest(request: RemoteCommandRequest): Promise<CommandState> {
    const existing = await this.prisma.commandLog.findUnique({ where: { id: request.id } });
    let command = existing;

    if (!command) {
      command = await this.prisma.commandLog.create({
        data: {
          id: request.id,
          siteId: this.localSiteId,
          target: request.target,
          name: request.name,
          params: request.params,
          status: 'PENDING',
          userId: request.userId ?? null,
        },
      });
    }

    if (command.status !== 'PENDING') {
      return this.mapCommand(command);
    }

    try {
      await this.serialService.queueCommand({
        id: request.id,
        target: request.target,
        name: request.name,
        params: request.params,
        line: request.line,
        userId: request.userId ?? undefined,
      });

      const updated = await this.prisma.commandLog.update({
        where: { id: request.id },
        data: {
          status: 'SENT',
          startedAt: new Date(),
        },
      });

      this.emitUpdate(updated);
      return this.mapCommand(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.prisma.commandLog.update({
        where: { id: request.id },
        data: {
          status: 'ERROR',
          errorText: message,
          finishedAt: new Date(),
        },
      });
      this.emitUpdate(failed);
      throw error;
    }
  }

  private mapCommand(command: CommandLog): CommandState {
    return {
      id: command.id,
      siteId: command.siteId ?? undefined,
      target: command.target,
      name: command.name,
      params: Array.isArray(command.params) ? (command.params as string[]) : [],
      status: command.status,
      userId: command.userId,
      createdAt: command.createdAt,
      startedAt: command.startedAt ?? undefined,
      finishedAt: command.finishedAt ?? undefined,
      ackKind: command.ackKind ?? undefined,
      ackStatus: command.ackStatus ?? undefined,
      ackNode: command.ackNode ?? undefined,
      resultText: command.resultText ?? undefined,
      errorText: command.errorText ?? undefined,
    };
  }

  private mapAckTypeToCommand(ackType: string): string | undefined {
    return ACK_TO_COMMAND[ackType];
  }

  private async findLatestMatchingCommand(
    name: string,
    nodeId?: string,
  ): Promise<CommandLog | null> {
    const directTarget = nodeId ? `@${nodeId}` : undefined;

    return this.prisma.commandLog.findFirst({
      where: {
        name,
        status: { in: ['PENDING', 'SENT'] },
        OR: nodeId ? [{ target: directTarget }, { target: '@ALL' }] : undefined,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  private deriveStatusFromAck(ackStatus: string, current: CommandStatus): CommandStatus {
    const normalized = ackStatus.toUpperCase();
    if (['COMPLETE', 'STOPPED', 'OK', 'FINISHED'].includes(normalized)) {
      return 'OK';
    }
    if (['ERROR', 'FAILED', 'TIMEOUT'].includes(normalized)) {
      return 'ERROR';
    }
    return current === 'PENDING' ? 'SENT' : current;
  }

  private normalizeStatus(status: string): CommandStatus {
    const normalized = status?.toUpperCase();
    if (
      normalized === 'PENDING' ||
      normalized === 'SENT' ||
      normalized === 'OK' ||
      normalized === 'ERROR'
    ) {
      return normalized as CommandStatus;
    }
    return 'PENDING';
  }
}
