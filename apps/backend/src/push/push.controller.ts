import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { PushService, PushSubscriptionInput } from './push.service';
import { RemoteAlertConfigService } from './remote-alert-config.service';
import { Public } from '../auth/auth.decorators';

@Controller('push')
export class PushController {
  constructor(
    private readonly pushService: PushService,
    private readonly config: RemoteAlertConfigService,
  ) {}

  @Public()
  @Get('remote-auth')
  @HttpCode(204)
  async remoteAuth(@Req() req: Request) {
    const login = req.header('tailscale-user-login')?.trim().toLowerCase();
    const { tsAllowedLogins } = await this.config.get();
    if (!login || !tsAllowedLogins.includes(login)) {
      throw new ForbiddenException();
    }
  }

  @Get('public-key')
  async publicKey(@Req() req: Request) {
    this.requireUser(req);
    return { publicKey: await this.pushService.getPublicKey() };
  }

  @Post('subscriptions')
  async subscribe(@Req() req: Request, @Body() body: PushSubscriptionInput) {
    await this.pushService.subscribe(this.requireUser(req), body);
    return { ok: true };
  }

  @Delete('subscriptions')
  async unsubscribe(@Req() req: Request, @Body() body: { endpoint?: string }) {
    if (typeof body?.endpoint === 'string') {
      await this.pushService.unsubscribe(this.requireUser(req), body.endpoint);
    }
    return { ok: true };
  }

  @Post('test')
  async test(@Req() req: Request) {
    await this.pushService.notify('AntiHunter', 'Test notification', this.requireUser(req));
    return { ok: true };
  }

  private requireUser(req: Request): string {
    const userId = req.auth?.sub;
    if (!userId) {
      throw new UnauthorizedException('Missing authentication context');
    }
    return userId;
  }
}
