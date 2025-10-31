import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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

@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);
  private readonly updates$ = new Subject<CommandState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly serialService: SerialService,
  ) {}

  getUpdatesStream(): Observable<CommandState> {
    return this.updates$.asObservable();
  }

  async sendCommand(dto: SendCommandDto, userId?: string): Promise<CommandState> {
    const commandId = randomUUID();
    const built = buildCommandPayload({
      target: dto.target,
      name: dto.name,
      params: dto.params,
    });

    const command = await this.prisma.commandLog.create({
      data: {
        id: commandId,
        userId,
        target: built.target,
        name: built.name,
        params: built.params,
        status: 'PENDING',
      },
    });

    this.emitUpdate(command);

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

  private mapCommand(command: CommandLog): CommandState {
    return {
      id: command.id,
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
}
