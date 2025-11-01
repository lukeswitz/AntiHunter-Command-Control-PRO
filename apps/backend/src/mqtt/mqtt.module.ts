import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MqttFederationService } from './mqtt-federation.service';
import { MqttController } from './mqtt.controller';
import { MqttService } from './mqtt.service';
import { NodesModule } from '../nodes/nodes.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule, NodesModule],
  providers: [MqttService, MqttFederationService],
  controllers: [MqttController],
  exports: [MqttService],
})
export class MqttModule {}
