import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MqttController } from './mqtt.controller';
import { MqttService } from './mqtt.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [MqttService],
  controllers: [MqttController],
  exports: [MqttService],
})
export class MqttModule {}
