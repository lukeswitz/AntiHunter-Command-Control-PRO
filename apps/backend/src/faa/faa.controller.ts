import { Controller, Get, Post } from '@nestjs/common';
import { Role } from '@prisma/client';

import { FaaRegistryService } from './faa.service';
import { Roles } from '../auth/auth.decorators';

@Controller('config/faa')
export class FaaController {
  constructor(private readonly faaRegistryService: FaaRegistryService) {}

  @Get('status')
  @Roles(Role.ADMIN, Role.OPERATOR)
  getStatus() {
    return this.faaRegistryService.getStatus();
  }

  @Post('sync')
  @Roles(Role.ADMIN)
  startSync() {
    return this.faaRegistryService.triggerSync();
  }
}
