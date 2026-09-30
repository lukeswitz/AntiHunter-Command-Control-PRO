import { forwardRef, Module } from '@nestjs/common';

import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';
import { GeofencesModule } from '../geofences/geofences.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WsModule } from '../ws/ws.module';

@Module({
  imports: [PrismaModule, GeofencesModule, forwardRef(() => WsModule)],
  controllers: [TargetsController],
  providers: [TargetsService],
  exports: [TargetsService],
})
export class TargetsModule {}
