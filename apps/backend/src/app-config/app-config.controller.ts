import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

import { AppConfigService } from './app-config.service';
import { UpdateAppSettingsDto } from './dto/update-app-settings.dto';
import { Roles } from '../auth/auth.decorators';

@Controller('config/app')
export class AppConfigController {
  constructor(private readonly appConfigService: AppConfigService) {}

  @Get()
  getAppSettings() {
    return this.appConfigService.getSettings();
  }

  @Get('database-stats')
  @Roles(Role.ADMIN)
  databaseStats() {
    return this.appConfigService.getDatabaseStats();
  }

  @Put()
  updateAppSettings(@Req() req: Request, @Body() body: UpdateAppSettingsDto) {
    return this.appConfigService.updateSettings(body, req.auth?.sub);
  }
}
