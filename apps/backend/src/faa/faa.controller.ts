import {
  BadRequestException,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import * as multer from 'multer';

import { FaaRegistryService } from './faa.service';
import { Roles } from '../auth/auth.decorators';

@Controller('config/faa')
export class FaaController {
  constructor(private readonly faaRegistryService: FaaRegistryService) {}

  @Get('status')
  @Roles(Role.ADMIN, Role.OPERATOR)
  getStatus() {
    return this.faaRegistryService.getStatus();
  }

  @Post('sync')
  @Roles(Role.ADMIN)
  startSync() {
    return this.faaRegistryService.triggerSync();
  }

  @Post('upload')
  @Roles(Role.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 250 * 1024 * 1024, // 250MB limit for MASTER.txt
      },
    }),
  )
  async uploadMaster(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return this.faaRegistryService.triggerUpload(file.buffer);
  }
}
