import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';

import { ConnectSerialDto } from './dto/connect-serial.dto';
import { UpdateSerialConfigDto } from './dto/update-serial-config.dto';
import { SerialConfigService } from './serial-config.service';
import { SerialService } from './serial.service';

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
      { id: 'meshtastic-like', label: 'Meshtastic JSON/CBOR (default)' },
      { id: 'raw-lines', label: 'Raw Lines (line-delimited text)' },
      { id: 'nmea-like', label: 'NMEA-like (comma separated)' },
    ];
  }

  @Get('config')
  getConfig(@Query('siteId') siteId?: string) {
    const targetSiteId = siteId ?? this.serialService.getSiteId();
    return this.serialConfigService.getConfig(targetSiteId);
  }

  @Put('config')
  updateConfig(@Body() dto: UpdateSerialConfigDto) {
    const targetSiteId = dto.siteId ?? this.serialService.getSiteId();
    return this.serialConfigService.updateConfig({ ...dto, siteId: targetSiteId });
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
}
