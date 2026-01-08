import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { CommandsController } from './commands.controller';
import { CommandsService } from './commands.service';
import { SerialModule } from '../serial/serial.module';
import { TriangulationModule } from '../triangulation/triangulation.module';

@Module({
  imports: [SerialModule, ConfigModule, TriangulationModule],
  controllers: [CommandsController],
  providers: [CommandsService],
  exports: [CommandsService],
})
export class CommandsModule {}
