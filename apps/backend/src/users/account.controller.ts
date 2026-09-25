import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';

import {
  AcceptInvitationDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/account-recovery.dto';
import { UsersService } from './users.service';
import { Public } from '../auth/auth.decorators';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Controller('auth')
@Public()
@UseGuards(RateLimitGuard)
export class AccountController {
  constructor(private readonly usersService: UsersService) {}

  @Post('forgot-password')
  @HttpCode(200)
  @RateLimit({ key: 'auth-recovery' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    this.usersService.requestPasswordReset(dto.email);
    return { ok: true };
  }

  @Post('reset-password')
  @HttpCode(200)
  @RateLimit({ key: 'auth-recovery', trackAuthFailure: true })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.usersService.resetPassword(dto.token, dto.password);
    return { ok: true };
  }

  @Post('accept-invite')
  @HttpCode(200)
  @RateLimit({ key: 'auth-recovery', trackAuthFailure: true })
  async acceptInvite(@Body() dto: AcceptInvitationDto) {
    await this.usersService.acceptInvitation(dto);
    return { ok: true };
  }
}
