import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { NodesController } from './nodes.controller';
import { NodesService } from './nodes.service';

@Module({
  imports: [ConfigModule],
  providers: [NodesService],
  controllers: [NodesController],
  exports: [NodesService],
})
export class NodesModule {}
