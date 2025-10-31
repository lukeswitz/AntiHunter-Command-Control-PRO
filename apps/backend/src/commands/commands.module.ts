import { Module } from '@nestjs/common';

import { CommandsController } from './commands.controller';
import { CommandsService } from './commands.service';
import { SerialModule } from '../serial/serial.module';

@Module({
  imports: [SerialModule],
  controllers: [CommandsController],
  providers: [CommandsService],
  exports: [CommandsService],
})
export class CommandsModule {}
