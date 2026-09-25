import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AccountController } from './account.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { FirewallModule } from '../firewall/firewall.module';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';

@Module({
  imports: [PrismaModule, MailModule, ConfigModule, RateLimitModule, FirewallModule],
  controllers: [UsersController, AccountController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
