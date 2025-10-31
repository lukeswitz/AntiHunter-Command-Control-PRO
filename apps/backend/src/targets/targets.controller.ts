import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CreateTargetDto } from './dto/create-target.dto';
import { ListTargetsDto } from './dto/list-targets.dto';
import { UpdateTargetDto } from './dto/update-target.dto';
import { TargetsService } from './targets.service';
import { Roles } from '../auth/auth.decorators';

@Controller('targets')
export class TargetsController {
  constructor(private readonly targetsService: TargetsService) {}

  @Get()
  list(@Query() query: ListTargetsDto) {
    return this.targetsService.list(query);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.targetsService.getById(id);
  }

  @Post()
  @Roles(Role.ADMIN, Role.OPERATOR)
  create(@Body() dto: CreateTargetDto) {
    return this.targetsService.create(dto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.OPERATOR)
  update(@Param('id') id: string, @Body() dto: UpdateTargetDto) {
    return this.targetsService.update(id, dto);
  }

  @Post(':id/resolve')
  @Roles(Role.ADMIN, Role.OPERATOR)
  resolve(@Param('id') id: string, @Body('notes') notes?: string) {
    return this.targetsService.resolve(id, notes);
  }

  @Delete('clear')
  @Roles(Role.ADMIN)
  clearAll() {
    return this.targetsService.clearAll();
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  delete(@Param('id') id: string) {
    if (id === 'clear') {
      return this.targetsService.clearAll();
    }
    return this.targetsService.delete(id);
  }
}
