import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { AllowLegalPending, Public } from './auth.decorators';
import { AuthService } from './auth.service';
import { LegalAckDto } from './dto/legal-ack.dto';
import { LoginDto } from './dto/login.dto';
import { LEGAL_DISCLAIMER } from './legal-disclaimer';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit(
    { key: 'auth-login-burst', trackAuthFailure: true },
    { key: 'auth-login', trackAuthFailure: true },
  )
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto, req);
  }

  @Get('me')
  @AllowLegalPending()
  async me(@Req() req: Request) {
    const userId = req.auth?.sub;
    if (!userId) {
      throw new BadRequestException('Missing authentication context');
    }
    const user = await this.authService.getUserById(userId);
    const legalAccepted = user.legalAccepted;

    return {
      user,
      legalAccepted,
      disclaimer: legalAccepted ? undefined : LEGAL_DISCLAIMER,
    };
  }

  @Post('legal-ack')
  @AllowLegalPending()
  @UseGuards(RateLimitGuard)
  @RateLimit({ key: 'auth-legal' })
  async acknowledge(@Req() req: Request, @Body() dto: LegalAckDto) {
    if (!dto.accepted) {
      throw new BadRequestException('Acknowledgement is required to continue');
    }
    const userId = req.auth?.sub;
    if (!userId) {
      throw new BadRequestException('Missing authentication context');
    }
    return this.authService.acknowledgeLegal(userId, req.auth?.rememberMe ?? false);
  }
}
