import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import * as multer from 'multer';

import { OuiService } from './oui.service';

@Controller('oui')
export class OuiController {
  constructor(private readonly ouiService: OuiService) {}

  @Get('stats')
  getStats() {
    return this.ouiService.getStats();
  }

  @Get('cache')
  getCache(@Query('limit') limit?: string, @Query('search') search?: string) {
    const take = limit ? Number(limit) : undefined;
    if (take !== undefined && (!Number.isFinite(take) || take <= 0)) {
      throw new BadRequestException('limit must be a positive number');
    }
    return this.ouiService.list(take, search);
  }

  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 15 * 1024 * 1024,
      },
    }),
  )
  async importOui(
    @UploadedFile() file: Express.Multer.File,
    @Query('mode') mode: 'replace' | 'merge' = 'replace',
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    return this.ouiService.importFromBuffer(file.buffer, file.originalname, mode);
  }

  @Get('export')
  async export(@Res() res: Response, @Query('format') format: 'csv' | 'json' = 'csv') {
    const entries = await this.ouiService.exportAll();
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="oui-cache.json"');
      res.send(JSON.stringify(entries, null, 2));
      return;
    }

    const lines = [
      'OUI,Vendor',
      ...entries.map((entry) => `${entry.oui},${escapeCsv(entry.vendor)}`),
    ];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="oui-cache.csv"');
    res.send(lines.join('\n'));
  }

  @Get('resolve/:mac')
  resolve(@Param('mac') mac: string) {
    return this.ouiService.resolve(mac);
  }
}

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
