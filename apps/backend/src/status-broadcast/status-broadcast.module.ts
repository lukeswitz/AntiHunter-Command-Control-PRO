import { Module } from '@nestjs/common';

import { StatusBroadcastController } from './status-broadcast.controller';
import { StatusBroadcastService } from './status-broadcast.service';
import { AppConfigModule } from '../app-config/app-config.module';
import { SerialModule } from '../serial/serial.module';

@Module({
  imports: [SerialModule, AppConfigModule],
  controllers: [StatusBroadcastController],
  providers: [StatusBroadcastService],
})
export class StatusBroadcastModule {}
