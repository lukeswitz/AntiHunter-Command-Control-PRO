import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import * as multer from 'multer';
import { extname } from 'node:path';

import { AlarmsService } from './alarms.service';
import { UpdateAlarmConfigDto } from './dto/update-alarm-config.dto';

const ALLOWED_EXT = new Set(['.wav', '.mp3', '.ogg']);

@Controller('alarms')
export class AlarmsController {
  constructor(private readonly alarmsService: AlarmsService) {}

  @Get()
  getConfig() {
    return this.alarmsService.getConfig();
  }

  @Put()
  updateConfig(@Body() body: UpdateAlarmConfigDto) {
    return this.alarmsService.updateConfig(body).then(() => this.alarmsService.getConfig());
  }

  @Post('sounds/:level')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      fileFilter: (_req, file, callback) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) {
          callback(new Error('Unsupported file format. Use WAV, MP3, or OGG.'), false);
          return;
        }
        callback(null, true);
      },
      limits: {
        fileSize: 5 * 1024 * 1024,
      },
    }),
  )
  async uploadSound(@Param('level') levelParam: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new Error('No file uploaded');
    }
    const level = this.alarmsService.validateLevel(levelParam);
    await this.alarmsService.saveSound(level, file.originalname, file.buffer);
    return this.alarmsService.getConfig();
  }

  @Delete('sounds/:level')
  async deleteSound(@Param('level') levelParam: string) {
    const level = this.alarmsService.validateLevel(levelParam);
    await this.alarmsService.removeSound(level);
    return this.alarmsService.getConfig();
  }
}
