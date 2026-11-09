import { Module } from '@nestjs/common';

import { KnownRadiosController } from './known-radios.controller';
import { KnownRadiosService } from './known-radios.service';
import { CommandsModule } from '../commands/commands.module';

@Module({
  imports: [CommandsModule],
  providers: [KnownRadiosService],
  controllers: [KnownRadiosController],
  exports: [KnownRadiosService],
})
export class KnownRadiosModule {}
