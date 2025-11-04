import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MqttCommandsService } from './mqtt-commands.service';
import { MqttEventsService } from './mqtt-events.service';
import { MqttFederationService } from './mqtt-federation.service';
import { MqttGeofencesService } from './mqtt-geofences.service';
import { MqttInventoryService } from './mqtt-inventory.service';
import { MqttTargetsService } from './mqtt-targets.service';
import { MqttController } from './mqtt.controller';
import { MqttService } from './mqtt.service';
import { CommandsModule } from '../commands/commands.module';
import { GeofencesModule } from '../geofences/geofences.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NodesModule } from '../nodes/nodes.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TargetsModule } from '../targets/targets.module';
import { WsModule } from '../ws/ws.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    NodesModule,
    CommandsModule,
    InventoryModule,
    TargetsModule,
    GeofencesModule,
    WsModule,
  ],
  providers: [
    MqttService,
    MqttFederationService,
    MqttCommandsService,
    MqttInventoryService,
    MqttTargetsService,
    MqttGeofencesService,
    MqttEventsService,
  ],
  controllers: [MqttController],
  exports: [MqttService],
})
export class MqttModule {}
