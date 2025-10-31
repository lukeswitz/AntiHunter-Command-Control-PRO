import { Module } from '@nestjs/common';

import { SerialConfigService } from './serial-config.service';
import { SerialController } from './serial.controller';
import { SerialService } from './serial.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [SerialService, SerialConfigService],
  controllers: [SerialController],
  exports: [SerialService, SerialConfigService],
})
export class SerialModule {}
