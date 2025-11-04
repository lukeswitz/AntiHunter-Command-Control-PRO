import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';

import { AllowLegalPending, AllowTwoFactorPending } from './auth.decorators';
import { AuthService } from './auth.service';
import { TwoFactorService } from './two-factor.service';
import { FirewallService } from '../firewall/firewall.service';
import { DisableTwoFactorDto, TwoFactorVerifyDto } from './dto/two-factor.dto';

@Controller('auth/2fa')
export class TwoFactorController {
  constructor(
    private readonly twoFactorService: TwoFactorService,
    private readonly authService: AuthService,
    private readonly firewallService: FirewallService,
  ) {}

  @Post('setup')
  async setup(@Req() req: Request) {
    const userId = req.auth?.sub;
    const email = req.auth?.email;
    if (!userId || !email) {
      throw new BadRequestException('Missing authentication context');
    }
    return this.twoFactorService.generateSecret(userId, email);
  }

  @Post('confirm')
  async confirm(@Req() req: Request, @Body() dto: TwoFactorVerifyDto) {
    const userId = req.auth?.sub;
    if (!userId) {
      throw new BadRequestException('Missing authentication context');
    }
    const { recoveryCodes } = await this.twoFactorService.confirmTwoFactor(userId, dto.code);
    const user = await this.authService.getUserById(userId);
    return { user, recoveryCodes };
  }

  @Post('disable')
  async disable(@Req() req: Request, @Body() dto: DisableTwoFactorDto) {
    const userId = req.auth?.sub;
    if (!userId) {
      throw new BadRequestException('Missing authentication context');
    }
    if (!dto.code && !dto.password) {
      throw new BadRequestException('Provide a current code or password to disable 2FA');
    }
    await this.twoFactorService.disableTwoFactor(userId, {
      code: dto.code,
      password: dto.password,
    });
    const user = await this.authService.getUserById(userId);
    return { user };
  }

  @Post('recovery/regenerate')
  async regenerate(@Req() req: Request, @Body() dto: TwoFactorVerifyDto) {
    const userId = req.auth?.sub;
    if (!userId) {
      throw new BadRequestException('Missing authentication context');
    }
    const codes = await this.twoFactorService.regenerateRecoveryCodes(userId, dto.code);
    return { recoveryCodes: codes };
  }

  @Post('verify')
  @AllowTwoFactorPending()
  @AllowLegalPending()
  async verify(@Req() req: Request, @Body() dto: TwoFactorVerifyDto) {
    const userId = req.auth?.sub;
    const email = req.auth?.email;
    const role = req.auth?.role;
    const legalAccepted = req.auth?.legalAccepted ?? true;
    if (!userId || !email || !role) {
      throw new BadRequestException('Missing authentication context');
    }
    const ip = this.firewallService.getClientIp(req);
    const userAgent = req.headers['user-agent'] as string | undefined;
    const path = req.path;
    try {
      const result = await this.twoFactorService.verifyLoginCode(userId, dto.code);
      if (ip) {
        await this.firewallService.registerAuthSuccess(ip, { path, userAgent });
      }
      const token = this.authService.createToken(userId, email, role, true);
      const user = await this.authService.getUserById(userId);
      return {
        token,
        user,
        legalAccepted,
        recoveryUsed: result.usingRecoveryCode,
      };
    } catch (error) {
      if (ip) {
        await this.firewallService.registerAuthFailure(ip, {
          reason: 'INVALID_TWO_FACTOR_CODE',
          path,
          userAgent,
        });
      }
      throw error;
    }
  }
}
