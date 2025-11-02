import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MqttCommandsService } from './mqtt-commands.service';
import { MqttFederationService } from './mqtt-federation.service';
import { MqttInventoryService } from './mqtt-inventory.service';
import { MqttTargetsService } from './mqtt-targets.service';
import { MqttController } from './mqtt.controller';
import { MqttService } from './mqtt.service';
import { CommandsModule } from '../commands/commands.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NodesModule } from '../nodes/nodes.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TargetsModule } from '../targets/targets.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    NodesModule,
    CommandsModule,
    InventoryModule,
    TargetsModule,
  ],
  providers: [
    MqttService,
    MqttFederationService,
    MqttCommandsService,
    MqttInventoryService,
    MqttTargetsService,
  ],
  controllers: [MqttController],
  exports: [MqttService],
})
export class MqttModule {}
