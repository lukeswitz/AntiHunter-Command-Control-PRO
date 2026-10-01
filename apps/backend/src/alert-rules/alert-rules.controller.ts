import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { AlertRulesService } from './alert-rules.service';
import { CreateAlertRuleDto } from './dto/create-alert-rule.dto';
import { ListAlertEventsDto } from './dto/list-alert-events.dto';
import { ListAlertRulesDto } from './dto/list-alert-rules.dto';
import { UpdateAlertRuleDto } from './dto/update-alert-rule.dto';

interface RequestAuth {
  userId: string;
  role: Role;
}

@Controller('alert-rules')
export class AlertRulesController {
  constructor(private readonly alertRulesService: AlertRulesService) {}

  @Get()
  list(@Req() req: Request, @Query() query: ListAlertRulesDto) {
    const auth = this.requireAuth(req);
    return this.alertRulesService.listRules(auth.userId, auth.role, query);
  }

  @Get('events')
  listEvents(@Req() req: Request, @Query() query: ListAlertEventsDto) {
    const auth = this.requireAuth(req);
    return this.alertRulesService.listEvents(auth.userId, auth.role, query);
  }

  @Delete('events')
  clearEvents(@Req() req: Request, @Query() query: ListAlertEventsDto) {
    const auth = this.requireAuth(req);
    return this.alertRulesService.clearEvents(auth.userId, auth.role, query.ruleId);
  }

  @Get(':id')
  getRule(@Req() req: Request, @Param('id') id: string) {
    const auth = this.requireAuth(req);
    return this.alertRulesService.getRule(id, auth.userId, auth.role);
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateAlertRuleDto) {
    const auth = this.requireAuth(req);
    return this.alertRulesService.createRule(auth.userId, auth.role, dto);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateAlertRuleDto) {
    const auth = this.requireAuth(req);
    return this.alertRulesService.updateRule(id, auth.userId, auth.role, dto);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    const auth = this.requireAuth(req);
    return this.alertRulesService.deleteRule(id, auth.userId, auth.role);
  }

  private requireAuth(req: Request): RequestAuth {
    const payload = req.auth;
    if (!payload?.sub) {
      throw new UnauthorizedException('Missing authentication context');
    }
    return { userId: payload.sub, role: payload.role };
  }
}
