import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, TargetStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CreateTargetDto } from './dto/create-target.dto';
import { ListTargetsDto } from './dto/list-targets.dto';
import { UpdateTargetDto } from './dto/update-target.dto';
import { normalizeMac } from '../utils/mac';

@Injectable()
export class TargetsService {
  private readonly logger = new Logger(TargetsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(dto: ListTargetsDto) {
    const where: Prisma.TargetWhereInput = {};

    if (dto.status) {
      where.status = dto.status;
    }

    if (dto.siteId) {
      where.siteId = dto.siteId;
    }

    if (dto.search) {
      const term = dto.search.trim();
      if (term) {
        where.OR = [
          { name: { contains: term, mode: 'insensitive' } },
          { notes: { contains: term, mode: 'insensitive' } },
          { url: { contains: term, mode: 'insensitive' } },
          { tags: { has: term } },
          { mac: { contains: term, mode: 'insensitive' } },
          { deviceType: { contains: term, mode: 'insensitive' } },
        ];
      }
    }

    return this.prisma.target.findMany({
      where,
      orderBy: [
        { status: 'asc' },
        { updatedAt: 'desc' },
      ],
    });
  }

  async getById(id: string) {
    const target = await this.prisma.target.findUnique({
      where: { id },
    });
    if (!target) {
      throw new NotFoundException(`Target ${id} not found`);
    }
    return target;
  }

  async create(dto: CreateTargetDto) {
    let normalizedMac: string | undefined;
    if (dto.mac) {
      try {
        normalizedMac = normalizeMac(dto.mac);
      } catch {
        throw new BadRequestException('mac must be a valid 6-byte address');
      }
    }

    const createData: Prisma.TargetUncheckedCreateInput = {
      name: dto.name ?? null,
      mac: normalizedMac ?? null,
      lat: dto.lat,
      lon: dto.lon,
      url: dto.url ?? null,
      notes: dto.notes ?? null,
      siteId: dto.siteId ?? null,
      createdBy: dto.createdBy ?? null,
      deviceType: dto.deviceType ?? null,
      firstNodeId: dto.firstNodeId ?? null,
    };

    if (dto.tags) {
      createData.tags = { set: dto.tags };
    }

    return this.prisma.target.create({
      data: createData,
    });
  }

  async update(id: string, dto: UpdateTargetDto) {
    await this.getById(id);

    const { status, mac, ...rest } = dto;

    let macValue: string | undefined;
    if (mac !== undefined) {
      try {
        macValue = normalizeMac(mac);
      } catch {
        throw new BadRequestException('mac must be a valid 6-byte address');
      }
    }

    const data: Prisma.TargetUncheckedUpdateInput = {
      status,
    };

    if (rest.name !== undefined) {
      data.name = rest.name ?? null;
    }
    if (rest.lat !== undefined) {
      data.lat = rest.lat;
    }
    if (rest.lon !== undefined) {
      data.lon = rest.lon;
    }
    if (rest.url !== undefined) {
      data.url = rest.url ?? null;
    }
    if (rest.notes !== undefined) {
      data.notes = rest.notes ?? null;
    }
    if (rest.tags !== undefined) {
      data.tags = { set: rest.tags ?? [] };
    }
    if (rest.siteId !== undefined) {
      data.siteId = rest.siteId ?? null;
    }
    if (rest.createdBy !== undefined) {
      data.createdBy = rest.createdBy ?? null;
    }
    if (rest.deviceType !== undefined) {
      data.deviceType = rest.deviceType ?? null;
    }
    if (rest.firstNodeId !== undefined) {
      data.firstNodeId = rest.firstNodeId ?? null;
    }

    if (mac !== undefined) {
      data.mac = macValue ?? null;
    }

    return this.prisma.target.update({
      where: { id },
      data,
    });
  }

  async resolve(id: string, notes?: string) {
    await this.getById(id);
    return this.prisma.target.update({
      where: { id },
      data: {
        status: TargetStatus.RESOLVED,
        notes: notes ?? undefined,
      },
    });
  }

  async delete(id: string) {
    await this.getById(id);
    await this.prisma.target.delete({
      where: { id },
    });
  }

  async applyTrackingEstimate(mac: string, lat: number, lon: number, siteId?: string | null): Promise<boolean> {
    let normalizedMac: string;
    try {
      normalizedMac = normalizeMac(mac);
    } catch {
      this.logger.warn(`Skipping tracking estimate for invalid MAC ${mac}`);
      return false;
    }

    const data: Prisma.TargetUpdateManyMutationInput = {
      lat,
      lon,
      updatedAt: new Date(),
    };

    try {
      const result = await this.prisma.target.updateMany({
        where: { mac: normalizedMac },
        data,
      });
      return result.count > 0;
    } catch (error) {
      this.logger.warn(
        `Unable to apply tracking estimate for ${normalizedMac}: ${error instanceof Error ? error.message : String(
          error,
        )}`,
      );
      return false;
    }
  }

  async clearAll(): Promise<{ deleted: number }> {
    const result = await this.prisma.target.deleteMany();
    return { deleted: result.count };
  }
}
