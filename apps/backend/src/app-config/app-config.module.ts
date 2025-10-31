import { Module } from '@nestjs/common';

import { AppConfigController } from './app-config.controller';
import { AppConfigService } from './app-config.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [AppConfigService],
  controllers: [AppConfigController],
  exports: [AppConfigService],
})
export class AppConfigModule {}
