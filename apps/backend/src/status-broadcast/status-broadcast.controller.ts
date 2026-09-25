import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Role } from '@prisma/client';

import { StatusBroadcastService } from './status-broadcast.service';
import { Roles } from '../auth/auth.decorators';

@Controller('status-broadcast')
export class StatusBroadcastController {
  constructor(private readonly statusBroadcast: StatusBroadcastService) {}

  @Get()
  last() {
    return { last: this.statusBroadcast.lastResult() };
  }

  @Post('send')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.OPERATOR)
  send() {
    return this.statusBroadcast.trigger();
  }
}
