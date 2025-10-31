import { Module } from '@nestjs/common';

import { OuiController } from './oui.controller';
import { OuiService } from './oui.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [OuiService],
  controllers: [OuiController],
  exports: [OuiService],
})
export class OuiModule {}
