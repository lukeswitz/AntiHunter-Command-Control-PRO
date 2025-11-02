import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MqttCommandsService } from './mqtt-commands.service';
import { MqttFederationService } from './mqtt-federation.service';
import { MqttController } from './mqtt.controller';
import { MqttService } from './mqtt.service';
import { CommandsModule } from '../commands/commands.module';
import { NodesModule } from '../nodes/nodes.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule, NodesModule, CommandsModule],
  providers: [MqttService, MqttFederationService, MqttCommandsService],
  controllers: [MqttController],
  exports: [MqttService],
})
export class MqttModule {}
