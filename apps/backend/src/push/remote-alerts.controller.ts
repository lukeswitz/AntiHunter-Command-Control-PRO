import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { RemoteAlertConfig, Role } from '@prisma/client';

import { AlertChannel, AlertChannelsService } from './alert-channels.service';
import { UpdateRemoteAlertConfigDto } from './dto/update-remote-alert-config.dto';
import { MatterService } from './matter.service';
import { PushService } from './push.service';
import { RemoteAlertConfigService } from './remote-alert-config.service';
import { Roles } from '../auth/auth.decorators';

const CHANNELS: AlertChannel[] = ['push', 'ntfy', 'signal', 'matrix', 'matter'];

function view(config: RemoteAlertConfig) {
  const { vapidPrivateKey, ntfyToken, matrixAccessToken, ...rest } = config;
  return {
    ...rest,
    hasVapidPrivateKey: Boolean(vapidPrivateKey),
    hasNtfyToken: Boolean(ntfyToken),
    hasMatrixAccessToken: Boolean(matrixAccessToken),
  };
}

@Controller('remote-alerts')
@Roles(Role.ADMIN)
export class RemoteAlertsController {
  constructor(
    private readonly config: RemoteAlertConfigService,
    private readonly channels: AlertChannelsService,
    private readonly matter: MatterService,
    private readonly push: PushService,
  ) {}

  @Get('config')
  async getConfig() {
    return view(await this.config.get());
  }

  @Put('config')
  async updateConfig(@Body() dto: UpdateRemoteAlertConfigDto) {
    return view(await this.config.update(dto));
  }

  @Delete('config/secret/:field')
  async clearSecret(@Param('field') field: string) {
    if (field !== 'ntfyToken' && field !== 'matrixAccessToken') {
      throw new BadRequestException('Unknown secret');
    }
    return view(await this.config.clearSecret(field));
  }

  @Post('vapid/generate')
  async generateVapid() {
    return { publicKey: await this.push.generateKeys() };
  }

  @Get('push/subscriptions')
  listSubscriptions() {
    return this.push.listSubscriptions();
  }

  @Delete('push/subscriptions')
  async removeSubscription(@Body() body: { endpoint?: string }) {
    if (typeof body?.endpoint !== 'string') {
      throw new BadRequestException('endpoint is required');
    }
    await this.push.removeSubscription(body.endpoint);
    return { ok: true };
  }

  @Post('test/:channel')
  async test(@Param('channel') channel: string) {
    if (!CHANNELS.includes(channel as AlertChannel)) {
      throw new BadRequestException('Unknown channel');
    }
    try {
      await this.channels.test(channel as AlertChannel);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ok: true };
  }

  @Get('matter/status')
  matterStatus() {
    return this.matter.status();
  }

  @Post('matter/restart')
  async matterRestart() {
    await this.matter.restart();
    return this.matter.status();
  }

  @Post('matter/erase')
  async matterErase() {
    await this.matter.erase();
    return this.matter.status();
  }
}
