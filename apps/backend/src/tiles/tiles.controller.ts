import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, Max, Min } from 'class-validator';
import { Request, Response } from 'express';

import { TilesService } from './tiles.service';
import { TILE_PROVIDERS } from './tiles.util';
import { Public, Roles } from '../auth/auth.decorators';

class PreloadDto {
  @IsIn(Object.keys(TILE_PROVIDERS))
  provider!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(-85.05)
  @Max(85.05)
  lat!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(50)
  radiusKm!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(19)
  minZoom!: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(19)
  maxZoom!: number;
}

@Controller('tiles')
export class TilesController {
  constructor(private readonly tiles: TilesService) {}

  @Get('key')
  key(@Req() req: Request) {
    const userId = req.auth?.sub;
    if (!userId) {
      throw new ForbiddenException();
    }
    return { key: this.tiles.issueKey(userId) };
  }

  @Get('status')
  async status() {
    return {
      online: this.tiles.isOnline(),
      providers: this.tiles.providers(),
      cache: await this.tiles.cacheStats(),
      preload: this.tiles.preloadState(),
    };
  }

  @Post('preload')
  @Roles(Role.ADMIN, Role.OPERATOR)
  preload(@Body() dto: PreloadDto) {
    return this.tiles.startPreload(dto);
  }

  @Delete('preload')
  @Roles(Role.ADMIN, Role.OPERATOR)
  @HttpCode(200)
  cancelPreload() {
    return { canceled: this.tiles.cancelPreload() };
  }

  @Delete('cache')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  async clearCache() {
    await this.tiles.clearCache();
    return { ok: true };
  }

  @Get(':provider/:z/:x/:y')
  @Public()
  async tile(
    @Param('provider') provider: string,
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Query('k') key: string | undefined,
    @Res() res: Response,
  ) {
    if (!this.tiles.isKeyValid(key)) {
      res.status(401).end();
      return;
    }
    const tile = await this.tiles.getTile(provider, z, x, y);
    if (!tile) {
      res.status(503).setHeader('Cache-Control', 'no-store').end();
      return;
    }
    res
      .status(200)
      .setHeader('Content-Type', tile.contentType)
      .setHeader('Cache-Control', 'private, max-age=86400')
      .setHeader('X-Tile-Cache', tile.source)
      .end(tile.data);
  }
}
