import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

import { SerialService } from './serial.service';
import { Roles } from '../auth/auth.decorators';

class SecondsDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3600)
  seconds!: number;
}

class NodeTargetDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(0xffffffff)
  nodeNum?: number;
}

class DisplayDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(86_400)
  screenOnSecs!: number;
}

class BluetoothDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsIn([0, 1, 2])
  mode?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000)
  @Max(999_999)
  fixedPin?: number;
}

class GpsModeDto {
  @IsIn([0, 1, 2])
  gpsMode!: number;
}

class FixedPositionDto {
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lon!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-500)
  @Max(10_000)
  alt?: number;
}

@Controller('radio')
export class RadioController {
  constructor(private readonly serial: SerialService) {}

  @Get()
  info() {
    return this.serial.getRadioInfo();
  }

  @Post('refresh')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.OPERATOR)
  async refresh() {
    await this.serial.radioAction({ action: 'refresh' });
    return { ok: true };
  }

  @Post('request-telemetry')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.OPERATOR)
  async requestTelemetry(@Body() dto: NodeTargetDto) {
    await this.serial.radioAction({ action: 'requestTelemetry', nodeNum: dto.nodeNum });
    return { ok: true };
  }

  @Post('request-node-info')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.OPERATOR)
  async requestNodeInfo(@Body() dto: NodeTargetDto) {
    await this.serial.radioAction({ action: 'requestNodeInfo', nodeNum: dto.nodeNum });
    return { ok: true };
  }

  @Post('sync-time')
  @HttpCode(200)
  @Roles(Role.ADMIN, Role.OPERATOR)
  async syncTime() {
    await this.serial.radioAction({ action: 'syncTime' });
    return { ok: true };
  }

  @Post('reboot')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async reboot(@Body() dto: SecondsDto) {
    await this.serial.radioAction({ action: 'reboot', seconds: dto.seconds });
    return { ok: true };
  }

  @Post('shutdown')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async shutdown(@Body() dto: SecondsDto) {
    await this.serial.radioAction({ action: 'shutdown', seconds: dto.seconds });
    return { ok: true };
  }

  @Post('wake')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async wake() {
    await this.serial.radioAction({ action: 'wake' });
    return { ok: true };
  }

  @Post('nodedb-reset')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async nodedbReset() {
    await this.serial.radioAction({ action: 'nodedbReset' });
    return { ok: true };
  }

  @Post('display')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async display(@Body() dto: DisplayDto) {
    await this.serial.radioAction({ action: 'setDisplay', screenOnSecs: dto.screenOnSecs });
    return { ok: true };
  }

  @Post('bluetooth')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async bluetooth(@Body() dto: BluetoothDto) {
    await this.serial.radioAction({ action: 'setBluetooth', ...dto });
    return { ok: true };
  }

  @Post('gps-mode')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async gpsMode(@Body() dto: GpsModeDto) {
    await this.serial.radioAction({ action: 'setGpsMode', gpsMode: dto.gpsMode });
    return { ok: true };
  }

  @Post('fixed-position')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async fixedPosition(@Body() dto: FixedPositionDto) {
    await this.serial.radioAction({ action: 'setFixedPosition', ...dto });
    return { ok: true };
  }

  @Post('fixed-position/remove')
  @HttpCode(200)
  @Roles(Role.ADMIN)
  async removeFixedPosition() {
    await this.serial.radioAction({ action: 'removeFixedPosition' });
    return { ok: true };
  }
}
