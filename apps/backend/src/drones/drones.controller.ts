import { Body, Controller, Delete, forwardRef, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';

import { DronesService } from './drones.service';
import { UpdateDroneStatusDto } from './dto/update-drone-status.dto';
import { Roles } from '../auth/auth.decorators';
import { CommandCenterGateway } from '../ws/command-center.gateway';

@Controller('drones')
export class DronesController {
  constructor(
    private readonly dronesService: DronesService,
    @Inject(forwardRef(() => CommandCenterGateway))
    private readonly gateway: CommandCenterGateway,
  ) {}

  @Get()
  list() {
    return this.dronesService.getSnapshot();
  }

  @Patch(':id/status')
  @Roles(Role.OPERATOR, Role.ADMIN)
  async updateStatus(@Param('id') id: string, @Body() dto: UpdateDroneStatusDto) {
    const snapshot = await this.dronesService.updateStatus(id, dto.status);
    this.gateway.emitEvent({
      type: 'drone.status',
      droneId: snapshot.droneId ?? snapshot.id,
      id: snapshot.id,
      status: snapshot.status,
      siteId: snapshot.siteId ?? undefined,
      siteName: snapshot.siteName ?? undefined,
      siteColor: snapshot.siteColor ?? undefined,
      siteCountry: snapshot.siteCountry ?? undefined,
      siteCity: snapshot.siteCity ?? undefined,
      nodeId: snapshot.nodeId ?? undefined,
      mac: snapshot.mac ?? undefined,
      lat: snapshot.lat,
      lon: snapshot.lon,
      originSiteId: snapshot.originSiteId ?? undefined,
      timestamp: snapshot.lastSeen?.toISOString(),
      faa: snapshot.faa ?? null,
    });
    return snapshot;
  }

  @Delete(':id')
  @Roles(Role.OPERATOR, Role.ADMIN)
  async delete(@Param('id') id: string) {
    await this.dronesService.remove(id);
    return { success: true };
  }

  @Post('clear')
  @Roles(Role.ADMIN)
  async clearAll() {
    await this.dronesService.clearAll();
    return { success: true };
  }
}
