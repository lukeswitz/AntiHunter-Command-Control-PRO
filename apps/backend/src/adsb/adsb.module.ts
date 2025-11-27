import { Module } from '@nestjs/common';

import { AdsbController } from './adsb.controller';
import { AdsbService } from './adsb.service';
import { MqttModule } from '../mqtt/mqtt.module';
import { WsModule } from '../ws/ws.module';

@Module({
  imports: [MqttModule, WsModule],
  controllers: [AdsbController],
  providers: [AdsbService],
  exports: [AdsbService],
})
export class AdsbModule {}
