import { Module } from '@nestjs/common';

import { AcarsController } from './acars.controller';
import { AcarsService } from './acars.service';
import { WsModule } from '../ws/ws.module';

@Module({
  imports: [WsModule],
  controllers: [AcarsController],
  providers: [AcarsService],
  exports: [AcarsService],
})
export class AcarsModule {}
