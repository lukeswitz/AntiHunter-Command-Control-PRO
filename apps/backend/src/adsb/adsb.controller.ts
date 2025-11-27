import { Body, Controller, Get, Post } from '@nestjs/common';

import { AdsbService } from './adsb.service';

@Controller('adsb')
export class AdsbController {
  constructor(private readonly adsbService: AdsbService) {}

  @Get('status')
  getStatus() {
    return this.adsbService.getStatus();
  }

  @Get('tracks')
  getTracks() {
    return this.adsbService.getTracks();
  }

  @Post('config')
  updateConfig(
    @Body()
    body: {
      enabled?: boolean;
      feedUrl?: string;
      intervalMs?: number;
    },
  ) {
    return this.adsbService.updateConfig(body);
  }
}
