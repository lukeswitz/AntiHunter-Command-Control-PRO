import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { Role } from '@prisma/client';

import { ConnectSerialDto } from './dto/connect-serial.dto';
import { SimulateSerialDto } from './dto/simulate-serial.dto';
import { UpdateSerialConfigDto } from './dto/update-serial-config.dto';
import { SerialConfigService } from './serial-config.service';
import { SerialService } from './serial.service';
import { Roles } from '../auth/auth.decorators';

@Controller('serial')
export class SerialController {
  constructor(
    private readonly serialService: SerialService,
    private readonly serialConfigService: SerialConfigService,
  ) {}

  @Get('ports')
  listPorts() {
    return this.serialService.listPorts();
  }

  @Get('state')
  getState() {
    return this.serialService.getState();
  }

  @Get('protocols')
  getProtocols() {
    return [
      { id: 'meshtastic-rewrite', label: 'Meshtastic Ingest (default)' },
      { id: 'raw-lines', label: 'Raw Lines (line-delimited text)' },
      { id: 'nmea-like', label: 'NMEA-like (comma separated)' },
    ];
  }

  @Get('config')
  getConfig() {
    return this.serialConfigService.getConfig();
  }

  @Put('config')
  updateConfig(@Body() dto: UpdateSerialConfigDto) {
    return this.serialConfigService.updateConfig(dto);
  }

  @Post('config/reset')
  resetConfig() {
    return this.serialConfigService.resetConfig();
  }

  @Post('connect')
  async connect(@Body() dto: ConnectSerialDto) {
    await this.serialService.connect(dto);
    return this.serialService.getState();
  }

  @Post('disconnect')
  async disconnect() {
    await this.serialService.disconnect();
    return this.serialService.getState();
  }

  @Post('simulate')
  @Roles(Role.ADMIN)
  async simulate(@Body() dto: SimulateSerialDto) {
    await this.serialService.simulateLines(dto.lines);
    return { accepted: dto.lines.length };
  }
}
