import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';

import { PrismaService } from '../prisma/prisma.service';

export interface SendMailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

interface EnvMailConfig {
  enabled: boolean;
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  secure: boolean;
  from: string;
  preview: boolean;
}

interface ResolvedMailConfig {
  enabled: boolean;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  secure: boolean;
  from: string;
  preview: boolean;
}

const APP_CONFIG_ID = 1;

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly envConfig: ResolvedMailConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const envMail = this.configService.get<EnvMailConfig>('mail');
    this.envConfig = {
      enabled: envMail?.enabled ?? false,
      host: envMail?.host,
      port: envMail?.port,
      user: envMail?.user,
      password: envMail?.pass,
      secure: envMail?.secure ?? false,
      from: envMail?.from ?? 'Command Center <no-reply@localhost>',
      preview: envMail?.preview ?? false,
    };
  }

  async sendMail(options: SendMailOptions): Promise<void> {
    const config = await this.resolveConfig();

    const payload = {
      from: config.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    };

    if (!config.enabled) {
      if (config.preview) {
        this.logger.log(
          `Email preview (to=${options.to}, subject=${options.subject}):\n${options.text ?? options.html ?? ''}`,
        );
      } else {
        this.logger.debug('Mail delivery disabled; skipping send.');
      }
      return;
    }

    if (config.preview) {
      this.logger.log(
        `Email preview (to=${options.to}, subject=${options.subject}):\n${options.text ?? options.html ?? ''}`,
      );
      return;
    }

    if (!config.host || !config.port) {
      this.logger.warn('Mail is enabled but host/port are not configured; skipping send.');
      return;
    }

    try {
      const transporter = createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth:
          config.user && config.password ? { user: config.user, pass: config.password } : undefined,
      });

      await transporter.sendMail(payload);
      this.logger.debug(`Email sent to ${options.to} subject=${options.subject}`);
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${options.to}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  private async resolveConfig(): Promise<ResolvedMailConfig> {
    const appConfig = await this.prisma.appConfig.findUnique({ where: { id: APP_CONFIG_ID } });

    if (!appConfig) {
      return this.envConfig;
    }

    if (!appConfig.mailEnabled) {
      return {
        enabled: false,
        preview: appConfig.mailPreview ?? this.envConfig.preview,
        from: appConfig.mailFrom ?? this.envConfig.from,
        host: this.envConfig.host,
        port: this.envConfig.port,
        user: this.envConfig.user,
        password: this.envConfig.password,
        secure: this.envConfig.secure,
      };
    }

    return {
      enabled: true,
      host: appConfig.mailHost ?? this.envConfig.host,
      port: appConfig.mailPort ?? this.envConfig.port,
      user: appConfig.mailUser ?? this.envConfig.user,
      password: appConfig.mailPassword ?? this.envConfig.password,
      secure: appConfig.mailSecure ?? this.envConfig.secure,
      from: appConfig.mailFrom ?? this.envConfig.from,
      preview: appConfig.mailPreview ?? false,
    };
  }
}
