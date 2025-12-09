import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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

  @Get('log')
  getSessionLog() {
    return this.adsbService.getSessionLog();
  }

  @Delete('log')
  clearSessionLog() {
    this.adsbService.clearSessionLog();
    return { cleared: true };
  }

  @Post('config')
  updateConfig(
    @Body()
    body: {
      enabled?: boolean;
      feedUrl?: string;
      intervalMs?: number;
      geofencesEnabled?: boolean;
      openskyEnabled?: boolean;
      openskyClientId?: string | null;
      openskyClientSecret?: string | null;
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
    // codeql[js/request-forgery] Admin-configured URL with protocol validation
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

  @Post('opensky/credentials')
  @UseInterceptors(FileInterceptor('file'))
  async uploadOpenskyCredentials(@UploadedFile() file?: Express.Multer.File) {
    if (!file || !file.buffer || !file.originalname) {
      throw new BadRequestException('No file uploaded');
    }
    try {
      return await this.adsbService.saveOpenskyCredentials(file.originalname, file.buffer);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid credentials file',
      );
    }
  }
}
