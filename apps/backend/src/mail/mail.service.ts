import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import sanitizeHtml from 'sanitize-html';

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

    // Sanitize HTML content to prevent XSS while preserving safe formatting
    // Subject and text are plain text and don't need sanitization
    const payload = {
      from: config.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html ? this.sanitizeHtmlContent(options.html) : undefined,
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

  /**
   * Sanitizes HTML content to prevent XSS attacks while preserving safe formatting.
   * Uses sanitize-html library with a strict allowlist of safe tags and attributes.
   */
  private sanitizeHtmlContent(html: string): string {
    return sanitizeHtml(html, {
      allowedTags: [
        // Text formatting
        'b',
        'i',
        'em',
        'strong',
        'u',
        'br',
        'p',
        'span',
        'div',
        // Lists
        'ul',
        'ol',
        'li',
        // Tables (useful for formatted emails)
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        // Headers
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        // Links (with strict attribute filtering)
        'a',
        // Images (with strict attribute filtering)
        'img',
        // Code blocks
        'code',
        'pre',
      ],
      allowedAttributes: {
        a: ['href', 'title', 'target'],
        img: ['src', 'alt', 'width', 'height'],
        '*': ['style'], // Allow inline styles but will be filtered by allowedStyles
      },
      allowedStyles: {
        '*': {
          // Allow safe CSS properties for formatting
          color: [/^#[0-9a-f]{3,6}$/i, /^rgb\(/i, /^rgba\(/i],
          'text-align': [/^left$/i, /^right$/i, /^center$/i],
          'font-size': [/^\d+(?:px|em|rem|%)$/],
          'font-weight': [/^bold$/i, /^normal$/i, /^\d{3}$/],
          'text-decoration': [/^underline$/i, /^none$/i],
          padding: [/^\d+(?:px|em|rem|%)$/],
          margin: [/^\d+(?:px|em|rem|%)$/],
          'background-color': [/^#[0-9a-f]{3,6}$/i, /^rgb\(/i, /^rgba\(/i],
        },
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      // Remove any script-related or dangerous protocols
      disallowedTagsMode: 'discard',
      // Remove all class attributes to prevent CSS-based attacks
      allowedClasses: {},
      // Enforce that links open in new tab for security
      transformTags: {
        a: (tagName, attribs) => ({
          tagName: 'a',
          attribs: {
            ...attribs,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
        }),
      },
    });
  }
}
