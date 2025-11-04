import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

import { BlockFirewallLogDto } from './dto/block-firewall-log.dto';
import { CreateFirewallRuleDto } from './dto/create-firewall-rule.dto';
import { ListFirewallLogsDto } from './dto/list-firewall-logs.dto';
import { UpdateFirewallConfigDto } from './dto/update-firewall-config.dto';
import { FirewallService } from './firewall.service';
import { Roles } from '../auth/auth.decorators';

@Controller('config/firewall')
@Roles(Role.ADMIN)
export class FirewallController {
  constructor(private readonly firewallService: FirewallService) {}

  @Get()
  getOverview() {
    return this.firewallService.getOverview();
  }

  @Put()
  updateConfig(@Body() dto: UpdateFirewallConfigDto) {
    return this.firewallService.updateConfig(dto);
  }

  @Get('rules')
  listRules() {
    return this.firewallService.listRules();
  }

  @Post('rules')
  createRule(@Req() req: Request, @Body() dto: CreateFirewallRuleDto) {
    return this.firewallService.createRule(dto, req.auth?.sub);
  }

  @Delete('rules/:id')
  deleteRule(@Param('id') id: string) {
    return this.firewallService.deleteRule(id);
  }

  @Get('logs')
  listLogs(@Query() query: ListFirewallLogsDto) {
    return this.firewallService.listLogs(query);
  }

  @Post('logs/:id/block')
  blockFromLog(@Req() req: Request, @Param('id') id: string, @Body() dto: BlockFirewallLogDto) {
    return this.firewallService.blockFromLog(id, dto, req.auth?.sub);
  }
}
