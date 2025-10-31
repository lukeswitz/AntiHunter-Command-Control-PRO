import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request, Response } from 'express';

import { Roles } from '../auth/auth.decorators';
import { ExportQueryDto } from './dto/export-query.dto';
import { ExportsService } from './exports.service';

@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Get(':type')
  @Roles(Role.ADMIN, Role.OPERATOR, Role.ANALYST)
  async getExport(
    @Param('type') type: string,
    @Query() query: ExportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.exportsService.generateExport(type, query, req.auth?.sub);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Type', result.contentType);
    res.send(result.data);
  }
}
