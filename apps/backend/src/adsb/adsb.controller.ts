import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

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
      geofencesEnabled?: boolean;
    },
  ) {
    return this.adsbService.updateConfig(body);
  }

  @Get('proxy')
  async proxy() {
    const feedUrl = this.adsbService.getFeedUrl();
    if (!feedUrl) {
      throw new BadRequestException('No ADSB feed configured');
    }
    // lgtm[js/request-forgery]
    const response = await fetch(feedUrl);
    if (!response.ok) {
      throw new Error(`Proxy fetch failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  @Post('database/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAircraftDatabase(@UploadedFile() file?: Express.Multer.File) {
    if (!file || !file.buffer || !file.originalname) {
      throw new BadRequestException('No file uploaded');
    }
    return this.adsbService.saveAircraftDatabase(file.originalname, file.buffer);
  }

  @Post('database')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAircraftDatabaseAlias(@UploadedFile() file?: Express.Multer.File) {
    return this.uploadAircraftDatabase(file);
  }
}
