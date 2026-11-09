import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsOptional, IsString, Length } from 'class-validator';
import { Request } from 'express';

import { KnownRadiosService } from './known-radios.service';
import { Roles } from '../auth/auth.decorators';

class AddKnownRadioDto {
  @IsString()
  @Length(17, 17)
  mac!: string;

  @IsString()
  @Length(1, 16)
  radio!: string;

  @IsOptional()
  @IsString()
  @Length(0, 31)
  name?: string;
}

@Controller('nodes/known-radios')
export class KnownRadiosController {
  constructor(private readonly knownRadios: KnownRadiosService) {}

  @Get()
  list() {
    return this.knownRadios.list();
  }

  @Post()
  @Roles(Role.ADMIN, Role.OPERATOR)
  add(@Req() req: Request, @Body() dto: AddKnownRadioDto) {
    return this.knownRadios.add(dto, req.auth?.sub);
  }

  @Post('sync')
  @Roles(Role.ADMIN, Role.OPERATOR)
  sync(@Req() req: Request) {
    return this.knownRadios.sync(req.auth?.sub);
  }

  @Delete(':mac')
  @Roles(Role.ADMIN, Role.OPERATOR)
  remove(@Req() req: Request, @Param('mac') mac: string) {
    return this.knownRadios.remove(mac, req.auth?.sub);
  }
}
