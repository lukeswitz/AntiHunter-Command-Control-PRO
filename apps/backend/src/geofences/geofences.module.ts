import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { GeofenceCrossingService } from './geofence-crossing.service';
import { GeofencesController } from './geofences.controller';
import { GeofencesService } from './geofences.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [GeofencesController],
  providers: [GeofencesService, GeofenceCrossingService],
  exports: [GeofencesService, GeofenceCrossingService],
})
export class GeofencesModule {}
