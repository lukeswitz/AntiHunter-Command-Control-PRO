import { Module } from '@nestjs/common';

import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
