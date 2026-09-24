import { Module } from '@nestjs/common';

import { AlertChannelsService } from './alert-channels.service';
import { MatterService } from './matter.service';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { RemoteAlertConfigService } from './remote-alert-config.service';
import { RemoteAlertsController } from './remote-alerts.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PushController, RemoteAlertsController],
  providers: [PushService, MatterService, AlertChannelsService, RemoteAlertConfigService],
  exports: [PushService, AlertChannelsService],
})
export class PushModule {}
