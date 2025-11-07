import { Injectable } from '@nestjs/common';
import { AppConfig, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { UpdateAppSettingsDto } from './dto/update-app-settings.dto';

const APP_CONFIG_ID = 1;

interface AppConfigResponse extends Omit<AppConfig, 'mailPassword'> {
  mailPasswordSet: boolean;
}

@Injectable()
export class AppConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(): Promise<AppConfigResponse> {
    const config = await this.ensureExists();
    return this.toResponse(config);
  }

  async updateSettings(dto: UpdateAppSettingsDto, actorId?: string): Promise<AppConfigResponse> {
    const existing = await this.ensureExists();
    const {
      mailPassword,
      alertColorIdle,
      alertColorInfo,
      alertColorNotice,
      alertColorAlert,
      alertColorCritical,
      ...rest
    } = dto;

    const data: Prisma.AppConfigUpdateInput = { ...rest };

    if (rest.mailHost !== undefined) {
      data.mailHost = this.normalizeNullableString(rest.mailHost);
    }

    if (rest.mailUser !== undefined) {
      data.mailUser = this.normalizeNullableString(rest.mailUser);
    }

    if (rest.securityAppUrl !== undefined) {
      const trimmed = (rest.securityAppUrl ?? '').trim();
      if (trimmed.length > 0) {
        data.securityAppUrl = trimmed;
      }
    }

    if (rest.mailFrom !== undefined) {
      const trimmed = rest.mailFrom.trim();
      if (trimmed.length > 0) {
        data.mailFrom = trimmed;
      }
    }

    if (alertColorIdle !== undefined) {
      Object.assign(data, { alertColorIdle: this.normalizeColor(alertColorIdle) });
    }

    if (alertColorInfo !== undefined) {
      Object.assign(data, { alertColorInfo: this.normalizeColor(alertColorInfo) });
    }

    if (alertColorNotice !== undefined) {
      Object.assign(data, { alertColorNotice: this.normalizeColor(alertColorNotice) });
    }

    if (alertColorAlert !== undefined) {
      Object.assign(data, { alertColorAlert: this.normalizeColor(alertColorAlert) });
    }

    if (alertColorCritical !== undefined) {
      Object.assign(data, { alertColorCritical: this.normalizeColor(alertColorCritical) });
    }

    if (mailPassword !== undefined) {
      const trimmed = mailPassword.trim();
      data.mailPassword = trimmed.length === 0 ? null : trimmed;
    }

    const updated = await this.prisma.appConfig.update({
      where: { id: APP_CONFIG_ID },
      data,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: actorId ?? null,
        action: 'APP_CONFIG_UPDATE',
        entity: 'AppConfig',
        entityId: String(APP_CONFIG_ID),
        before: this.toAuditSnapshot(existing),
        after: this.toAuditSnapshot(updated),
      },
    });

    return this.toResponse(updated);
  }

  private async ensureExists(): Promise<AppConfig> {
    return this.prisma.appConfig.upsert({
      where: { id: APP_CONFIG_ID },
      update: {},
      create: { id: APP_CONFIG_ID },
    });
  }

  private toResponse(config: AppConfig): AppConfigResponse {
    const { mailPassword, ...rest } = config;
    return {
      ...rest,
      mailPasswordSet: !!mailPassword,
    };
  }

  private toAuditSnapshot(config: AppConfig) {
    const { mailPassword, ...rest } = config;
    return {
      ...rest,
      mailPasswordSet: !!mailPassword,
    };
  }

  private normalizeNullableString(value?: string | null) {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  private normalizeColor(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith('#')) {
      return `#${trimmed.toUpperCase()}`;
    }
    return `#${trimmed.slice(1).toUpperCase()}`;
  }
}
