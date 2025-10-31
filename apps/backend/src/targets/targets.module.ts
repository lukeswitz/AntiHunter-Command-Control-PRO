import { Module } from '@nestjs/common';

import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TargetsController],
  providers: [TargetsService],
  exports: [TargetsService],
})
export class TargetsModule {}
