import { Module } from '@nestjs/common';

import { FleetSecController } from './fleet-sec.controller';
import { FleetSecService } from './fleet-sec.service';
import { FleetStore } from './fleet-store';
import { PrismaModule } from '../prisma/prisma.module';
import { SerialModule } from '../serial/serial.module';

@Module({
  imports: [PrismaModule, SerialModule],
  controllers: [FleetSecController],
  providers: [FleetSecService, FleetStore],
})
export class FleetSecModule {}
