import { BadRequestException, Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Request } from 'express';

import { AllowLegalPending, Public } from './auth.decorators';
import { AuthService } from './auth.service';
import { LegalAckDto } from './dto/legal-ack.dto';
import { LoginDto } from './dto/login.dto';
import { LEGAL_DISCLAIMER } from './legal-disclaimer';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Post('legal-ack')
  @AllowLegalPending()
  async acknowledgeLegal(@Req() req: Request, @Body() dto: LegalAckDto) {
    if (!dto.accepted) {
      throw new BadRequestException('LEGAL_ACK_REQUIRED');
    }
    const userId = req.auth?.sub;
    if (!userId) {
      throw new BadRequestException('Missing authentication context');
    }
    return this.authService.acknowledgeLegal(userId);
  }

  @Get('me')
  @AllowLegalPending()
  async me(@Req() req: Request) {
    const userId = req.auth?.sub;
    if (!userId) {
      throw new BadRequestException('Missing authentication context');
    }
    const user = await this.authService.getUserById(userId);
    return {
      user,
      legalAccepted: user.legalAccepted,
      disclaimer: user.legalAccepted ? undefined : LEGAL_DISCLAIMER,
    };
  }
}
