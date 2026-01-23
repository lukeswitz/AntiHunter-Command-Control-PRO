import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { SystemUpdateService } from './system-update.service';
import { Roles } from '../auth/auth.decorators';

@Controller('system/update')
export class SystemUpdateController {
  constructor(private readonly systemUpdateService: SystemUpdateService) {}

  @Get('check')
  @Roles('ADMIN')
  async checkForUpdate() {
    return this.systemUpdateService.checkForUpdate();
  }

  @Post()
  @Roles('ADMIN')
  @HttpCode(HttpStatus.OK)
  async performUpdate() {
    return this.systemUpdateService.performUpdate();
  }
}
