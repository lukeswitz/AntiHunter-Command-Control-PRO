import { Module } from '@nestjs/common';

import { TilesController } from './tiles.controller';
import { TilesService } from './tiles.service';

@Module({
  controllers: [TilesController],
  providers: [TilesService],
})
export class TilesModule {}
