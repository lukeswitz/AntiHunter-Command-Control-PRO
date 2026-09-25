import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { UpdateSiteDto } from './dto/update-site.dto';

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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

  async remove(id: string) {
    await this.getById(id);
    if (id === this.config.get<string>('site.id', 'default')) {
      throw new ConflictException('Cannot delete the local site this server runs as.');
    }
    const [nodes, targets, geofences, devices, drones, userAccess] = await Promise.all([
      this.prisma.node.count({ where: { siteId: id } }),
      this.prisma.target.count({ where: { siteId: id } }),
      this.prisma.geofence.count({ where: { siteId: id } }),
      this.prisma.inventoryDevice.count({ where: { siteId: id } }),
      this.prisma.drone.count({ where: { siteId: id } }),
      this.prisma.userSiteAccess.count({ where: { siteId: id } }),
    ]);
    const blockers = [
      nodes && `${nodes} node(s)`,
      targets && `${targets} target(s)`,
      geofences && `${geofences} geofence(s)`,
      devices && `${devices} inventory device(s)`,
      drones && `${drones} drone(s)`,
      userAccess && `${userAccess} user assignment(s)`,
    ].filter((value): value is string => Boolean(value));
    if (blockers.length > 0) {
      throw new ConflictException(
        `Site is in use by ${blockers.join(', ')}. Move or remove them first.`,
      );
    }
    await this.prisma.site.delete({ where: { id } });
    return { ok: true };
  }
}
