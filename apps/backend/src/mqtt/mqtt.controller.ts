import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';

import { UpdateMqttConfigDto } from './dto/update-mqtt-config.dto';
import { MqttService } from './mqtt.service';

@Controller('mqtt')
export class MqttController {
  constructor(private readonly mqttService: MqttService) {}

  @Get('sites')
  listSites() {
    return this.mqttService.listSiteConfigs();
  }

  @Get('sites/:siteId')
  getSiteConfig(@Param('siteId') siteId: string) {
    return this.mqttService.getSiteConfig(siteId);
  }

  @Put('sites/:siteId')
  updateSiteConfig(@Param('siteId') siteId: string, @Body() dto: UpdateMqttConfigDto) {
    return this.mqttService.updateSiteConfig(siteId, dto);
  }

  @Get('sites-status')
  listStatuses() {
    return this.mqttService.listStatuses();
  }

  @Get('sites/:siteId/status')
  getSiteStatus(@Param('siteId') siteId: string) {
    return this.mqttService.getSiteStatus(siteId);
  }

  @Post('sites/:siteId/test')
  testConnection(@Param('siteId') siteId: string) {
    return this.mqttService.testSiteConnection(siteId);
  }

  @Post('sites/:siteId/restart')
  restart(@Param('siteId') siteId: string) {
    return this.mqttService.reconnectSite(siteId);
  }
}
