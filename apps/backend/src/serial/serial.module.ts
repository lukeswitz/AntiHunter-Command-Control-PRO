import { Module } from '@nestjs/common';

import { RadioController } from './radio.controller';
import { SerialConfigService } from './serial-config.service';
import { SerialController } from './serial.controller';
import { SerialService } from './serial.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [SerialService, SerialConfigService],
  controllers: [SerialController, RadioController],
  exports: [SerialService, SerialConfigService],
})
export class SerialModule {}
