import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { UpdateSiteDto } from './dto/update-site.dto';

@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.site.findMany();
  }

  async getById(id: string) {
    const site = await this.prisma.site.findUnique({ where: { id } });
    if (!site) {
      throw new NotFoundException(`Site ${id} not found`);
    }
    return site;
  }

  async update(id: string, dto: UpdateSiteDto) {
    return this.prisma.site.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        color: dto.color ?? undefined,
        region: dto.region ?? undefined,
        country: dto.country ?? undefined,
        city: dto.city ?? undefined,
      },
    });
  }
}
