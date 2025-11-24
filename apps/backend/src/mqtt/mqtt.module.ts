import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { MqttCommandsService } from './mqtt-commands.service';
import { MqttDronesService } from './mqtt-drones.service';
import { MqttEventsService } from './mqtt-events.service';
import { MqttFederationService } from './mqtt-federation.service';
import { MqttGeofencesService } from './mqtt-geofences.service';
import { MqttInventoryService } from './mqtt-inventory.service';
import { MqttTargetsService } from './mqtt-targets.service';
import { MqttController } from './mqtt.controller';
import { MqttService } from './mqtt.service';
import { CommandsModule } from '../commands/commands.module';
import { DronesModule } from '../drones/drones.module';
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
    DronesModule,
  ],
  providers: [
    MqttService,
    MqttFederationService,
    MqttCommandsService,
    MqttInventoryService,
    MqttTargetsService,
    MqttGeofencesService,
    MqttEventsService,
    MqttDronesService,
  ],
  controllers: [MqttController],
  exports: [MqttService],
})
export class MqttModule {}
