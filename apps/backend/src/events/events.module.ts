import { Global, Module } from '@nestjs/common';

import { EventBusService } from './event-bus.service';

@Global()
@Module({
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventsModule {}
