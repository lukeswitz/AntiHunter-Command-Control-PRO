import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role, SiteAccessLevel } from '@prisma/client';
import * as argon2 from 'argon2';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

import { AuthTokenPayload } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { LEGAL_DISCLAIMER } from './legal-disclaimer';
import { CommandCenterEvent, EventBusService } from '../events/event-bus.service';
import { FirewallService } from '../firewall/firewall.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_FEATURES_BY_ROLE } from '../users/user-permissions.constants';

interface PreferencesResponse {
  theme: string;
  density: string;
  language: string;
  timeFormat: string;
  notifications: Record<string, unknown> | null;
}

interface SiteAccessResponse {
  siteId: string;
  level: SiteAccessLevel;
  siteName?: string | null;
}

interface UserResponse {
  id: string;
  email: string;
  role: Role;
  legalAccepted: boolean;
  legalAcceptedAt?: Date | null;
  twoFactorEnabled: boolean;
  twoFactorEnabledAt?: Date | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  isActive: boolean;
  failedLoginAttempts: number;
  lastFailedLoginAt?: Date | null;
  lockedAt?: Date | null;
  lockedUntil?: Date | null;
  lockedReason?: string | null;
  lastLoginAt?: Date | null;
  lastLoginIp?: string | null;
  lastLoginCountry?: string | null;
  lastLoginUserAgent?: string | null;
  anomalyFlag: boolean;
  createdAt: Date;
  updatedAt: Date;
  preferences: PreferencesResponse;
  permissions: string[];
  siteAccess: SiteAccessResponse[];
}

interface LoginResult {
  token: string;
  user: UserResponse;
  legalAccepted: boolean;
  disclaimer?: string;
  twoFactorRequired?: boolean;
  postLoginNotice?: string;
}

type UserWithRelations = Prisma.UserGetPayload<{
  include: {
    preferences: true;
    permissions: true;
    siteAccess: { include: { site: true } };
  };
}>;

@Injectable()
export class AuthService {
  private readonly jwtSecret: jwt.Secret = process.env.JWT_SECRET ?? 'command-center-dev-secret';
  private readonly tokenTtl = process.env.JWT_EXPIRY ?? '12h';
  private readonly twoFactorTokenTtl = process.env.TWO_FACTOR_TOKEN_EXPIRY ?? '10m';
  private readonly loginMinSubmitMs: number;
  private readonly lockoutEnabled: boolean;
  private readonly lockoutThreshold: number;
  private readonly lockoutDurationMinutes: number;
  private readonly lockoutRecipients: string[];
  private readonly anomalyRecipients: string[];
  private readonly requireAnomalyTwoFactor: boolean;
  private readonly securityAlertRecipients: string[];
  private readonly baseUserInclude = {
    preferences: true,
    permissions: true,
    siteAccess: { include: { site: true } },
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly firewallService: FirewallService,
    private readonly eventBus: EventBusService,
    private readonly mailService: MailService,
    configService: ConfigService,
  ) {
    const configValue = configService.get<number>('rateLimit.form.loginMinSubmitMs', 600);
    this.loginMinSubmitMs = Number.isFinite(configValue) ? Math.max(0, configValue) : 600;
    const lockoutConfig = configService.get<{
      enabled?: boolean;
      threshold?: number;
      durationMinutes?: number;
      notify?: string[];
    }>('auth.lockout');
    const anomalyConfig = configService.get<{
      requireTwoFactor?: boolean;
      notify?: string[];
    }>('auth.anomaly');
    const securityRecipients = configService.get<string[]>('security.alertRecipients') ?? [];

    this.lockoutEnabled = lockoutConfig?.enabled !== false;
    this.lockoutThreshold = Math.max(1, lockoutConfig?.threshold ?? 5);
    this.lockoutDurationMinutes = Math.max(0, lockoutConfig?.durationMinutes ?? 0);
    this.lockoutRecipients = lockoutConfig?.notify?.length
      ? lockoutConfig.notify
      : securityRecipients;
    this.anomalyRecipients = anomalyConfig?.notify?.length
      ? anomalyConfig.notify
      : securityRecipients;
    this.requireAnomalyTwoFactor = anomalyConfig?.requireTwoFactor !== false;
    this.securityAlertRecipients = securityRecipients;
  }

  async login(dto: LoginDto, req?: Request): Promise<LoginResult> {
    const ip = this.firewallService.getClientIp(req);
    const userAgent = req?.headers['user-agent'] as string | undefined;
    const path = req?.path ?? '/auth/login';
    const email = dto.email;
    const password = dto.password;
    const country = ip ? this.firewallService.lookupCountry(ip) : undefined;

    const normalizedHoneypot = dto.honeypot?.trim();
    if (normalizedHoneypot) {
      if (ip) {
        await this.firewallService.registerAuthFailure(ip, {
          reason: 'HONEYPOT_FIELD',
          path,
          userAgent,
        });
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    if (typeof dto.submittedAt === 'number' && Number.isFinite(dto.submittedAt)) {
      const delta = Date.now() - dto.submittedAt;
      if (delta < this.loginMinSubmitMs) {
        if (ip) {
          await this.firewallService.registerAuthFailure(ip, {
            reason: 'FORM_SUBMITTED_TOO_FAST',
            path,
            userAgent,
          });
        }
        throw new UnauthorizedException('Invalid credentials');
      }
    }

    let user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: this.baseUserInclude,
    });
    if (!user) {
      if (ip) {
        await this.firewallService.registerAuthFailure(ip, {
          reason: 'UNKNOWN_ACCOUNT',
          path,
          userAgent,
        });
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    user = await this.refreshLockedState(user);

    if (user.lockedAt) {
      if (ip) {
        await this.firewallService.registerAuthFailure(ip, {
          reason: 'ACCOUNT_LOCKED',
          path,
          userAgent,
        });
      }
      throw new UnauthorizedException('Account is temporarily locked. Contact an administrator.');
    }

    if (!user.isActive) {
      if (ip) {
        await this.firewallService.registerAuthFailure(ip, {
          reason: 'ACCOUNT_DISABLED',
          path,
          userAgent,
        });
      }
      throw new UnauthorizedException('Account has been deactivated');
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      await this.handleFailedLogin(user, ip, path, userAgent);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (ip) {
      await this.firewallService.registerAuthSuccess(ip, { path, userAgent, country });
    }

    const anomalyDetected = this.detectAnomaly(user, ip, country);
    const updatedUser = await this.handleSuccessfulLogin(user, {
      ip,
      country,
      userAgent,
      anomalyDetected,
    });

    let postLoginNotice: string | undefined;
    if (anomalyDetected) {
      postLoginNotice = this.buildAnomalyNotice(user, ip, country);
      await this.emitSecurityAlert(
        `Anomalous login detected for ${updatedUser.email}`,
        'ALERT',
        {
          userId: updatedUser.id,
          ip,
          country,
        },
        this.anomalyRecipients,
      );
      if (this.requireAnomalyTwoFactor && !updatedUser.twoFactorEnabled) {
        postLoginNotice =
          postLoginNotice ??
          'Unusual login detected. Enable two-factor authentication to avoid account lockouts.';
      }
    }

    const userResponse = this.toUserResponse(updatedUser);
    const legalAccepted = !!updatedUser.legalAcceptedAt;

    if (!legalAccepted) {
      const token = this.createToken(updatedUser.id, updatedUser.email, updatedUser.role, false);
      return {
        token,
        user: userResponse,
        legalAccepted: false,
        disclaimer: LEGAL_DISCLAIMER,
        postLoginNotice,
      };
    }

    if (updatedUser.twoFactorEnabled && updatedUser.twoFactorSecret) {
      const token = this.createToken(updatedUser.id, updatedUser.email, updatedUser.role, true, {
        twoFactorPending: true,
        expiresIn: this.twoFactorTokenTtl,
      });
      return {
        token,
        user: userResponse,
        legalAccepted: true,
        twoFactorRequired: true,
        postLoginNotice,
      };
    }

    const token = this.createToken(updatedUser.id, updatedUser.email, updatedUser.role, true);
    return {
      token,
      user: userResponse,
      legalAccepted: true,
      postLoginNotice,
    };
  }

  async acknowledgeLegal(userId: string): Promise<LoginResult> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { legalAcceptedAt: new Date() },
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
    });

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      const token = this.createToken(user.id, user.email, user.role, true, {
        twoFactorPending: true,
        expiresIn: this.twoFactorTokenTtl,
      });
      return {
        token,
        user: this.toUserResponse(user),
        legalAccepted: true,
        twoFactorRequired: true,
      };
    }

    const token = this.createToken(user.id, user.email, user.role, true);

    return {
      token,
      user: this.toUserResponse(user),
      legalAccepted: true,
    };
  }

  async getUserById(userId: string): Promise<UserResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
    });
    if (!user) {
      throw new UnauthorizedException('Account no longer exists');
    }
    return this.toUserResponse(user);
  }

  async verifyToken(token: string): Promise<AuthTokenPayload> {
    const payload = jwt.verify(token, this.jwtSecret) as AuthTokenPayload;
    return payload;
  }

  async getUserFeatures(userId: string, role: Role): Promise<string[]> {
    const permissions = await this.prisma.userPermission.findMany({
      where: { userId },
      select: { feature: true },
    });
    if (!permissions.length) {
      return [...(DEFAULT_FEATURES_BY_ROLE[role] ?? [])];
    }
    return permissions.map((permission) => permission.feature);
  }

  createToken(
    id: string,
    email: string,
    role: Role,
    legalAccepted: boolean,
    options?: { twoFactorPending?: boolean; expiresIn?: string | number },
  ): string {
    const payload: Partial<AuthTokenPayload> = {
      sub: id,
      email,
      role,
      legalAccepted,
      twoFactorPending: options?.twoFactorPending ?? false,
    };

    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: (options?.expiresIn ?? this.tokenTtl) as jwt.SignOptions['expiresIn'],
    });
  }

  private async refreshLockedState(user: UserWithRelations): Promise<UserWithRelations> {
    if (!user.lockedAt) {
      return user;
    }
    if (user.lockedUntil && user.lockedUntil <= new Date()) {
      return this.prisma.user.update({
        where: { id: user.id },
        data: {
          lockedAt: null,
          lockedUntil: null,
          lockedReason: null,
          lockedBy: null,
          failedLoginAttempts: 0,
        },
        include: this.baseUserInclude,
      });
    }
    return user;
  }

  private async handleFailedLogin(
    user: UserWithRelations,
    ip?: string | null,
    path?: string,
    userAgent?: string,
  ): Promise<void> {
    const nextAttempts = (user.failedLoginAttempts ?? 0) + 1;
    const data: Prisma.UserUpdateInput = {
      failedLoginAttempts: nextAttempts,
      lastFailedLoginAt: new Date(),
    };
    let locked = false;
    if (this.lockoutEnabled && nextAttempts >= this.lockoutThreshold) {
      locked = true;
      data.failedLoginAttempts = 0;
      data.lockedAt = new Date();
      data.lockedBy = null;
      data.lockedReason = 'TOO_MANY_FAILURES';
      data.lockedUntil =
        this.lockoutDurationMinutes > 0
          ? new Date(Date.now() + this.lockoutDurationMinutes * 60_000)
          : null;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data,
    });

    if (ip) {
      await this.firewallService.registerAuthFailure(ip, {
        reason: locked ? 'ACCOUNT_LOCKED' : 'INVALID_PASSWORD',
        path,
        userAgent,
      });
    }

    if (locked) {
      await this.emitSecurityAlert(
        `Account locked after repeated failures: ${user.email}`,
        'ALERT',
        {
          userId: user.id,
          ip,
        },
        this.lockoutRecipients.length ? this.lockoutRecipients : undefined,
        [user.email],
      );
      await this.writeSecurityAudit('ACCOUNT_LOCK', user.id, null, {
        reason: 'TOO_MANY_FAILURES',
        lockedAt: new Date().toISOString(),
      });
    }
  }

  private detectAnomaly(user: UserWithRelations, ip?: string | null, country?: string): boolean {
    if (!ip && !country) {
      return false;
    }
    const ipChanged = user.lastLoginIp && ip && user.lastLoginIp !== ip;
    const countryChanged = user.lastLoginCountry && country && user.lastLoginCountry !== country;
    return Boolean(ipChanged || countryChanged);
  }
  private async handleSuccessfulLogin(
    user: UserWithRelations,
    context: {
      ip?: string | null;
      country?: string;
      userAgent?: string;
      anomalyDetected?: boolean;
    },
  ): Promise<Prisma.UserGetPayload<{ include: typeof this.baseUserInclude }>> {
    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lastFailedLoginAt: null,
        lockedAt: null,
        lockedUntil: null,
        lockedReason: null,
        lockedBy: null,
        anomalyFlag: context.anomalyDetected ?? false,
        lastLoginAt: new Date(),
        lastLoginIp: context.ip ?? null,
        lastLoginCountry: context.country ?? null,
        lastLoginUserAgent: context.userAgent ?? null,
      },
      include: this.baseUserInclude,
    });
  }

  private buildAnomalyNotice(
    previous: UserWithRelations,
    ip?: string | null,
    country?: string,
  ): string {
    const previousCountry = previous.lastLoginCountry ?? 'an unknown location';
    const newCountry = country ?? 'an unknown location';
    if (previousCountry === newCountry && previous.lastLoginIp === ip) {
      return 'We detected an unusual login on your account.';
    }
    if (previousCountry !== newCountry) {
      return `We detected a login from ${newCountry}. Your last session originated from ${previousCountry}.`;
    }
    if (previous.lastLoginIp && ip && previous.lastLoginIp !== ip) {
      return `We detected a login from a new network (${ip}). Previously you signed in from ${previous.lastLoginIp}.`;
    }
    return 'We detected an unusual login on your account.';
  }

  private async emitSecurityAlert(
    message: string,
    level: 'NOTICE' | 'ALERT',
    data?: Record<string, unknown>,
    recipients?: string[],
    additionalRecipients?: string[],
  ): Promise<void> {
    const payload: CommandCenterEvent = {
      type: 'event.alert',
      level,
      category: 'security',
      message,
      timestamp: new Date().toISOString(),
      data,
    };
    this.eventBus.publish(payload);

    const targets = this.normalizeRecipientList(
      recipients?.length ? recipients : this.securityAlertRecipients,
      additionalRecipients,
    );
    if (targets.length === 0) {
      return;
    }

    const body = `${message}${
      data ? `\n\nDetails: ${JSON.stringify(data, null, 2)}` : ''
    }\n\nThis notification was generated automatically by AntiHunter Command Center.`;
    await this.notifyRecipients(targets, `[AHCC] Security Alert`, body);
  }

  private normalizeRecipientList(...lists: (string[] | undefined)[]): string[] {
    const merged = new Set<string>();
    lists
      .flatMap((list) => list ?? [])
      .forEach((entry) => {
        const trimmed = entry.trim();
        if (trimmed) {
          merged.add(trimmed.toLowerCase());
        }
      });
    return Array.from(merged);
  }

  private async notifyRecipients(recipients: string[], subject: string, text: string) {
    await Promise.all(
      recipients.map((to) =>
        this.mailService
          .sendMail({
            to,
            subject,
            text,
          })
          .catch((error) => {
            // do not block login if email fails
            console.warn(`Failed to send security email to ${to}: ${(error as Error).message}`);
          }),
      ),
    );
  }

  private async writeSecurityAudit(
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        action,
        entity: 'Security',
        entityId,
        before: this.toJsonValue(before),
        after: this.toJsonValue(after),
      },
    });
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    if (value === undefined || value === null) {
      return Prisma.JsonNull;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.toJsonValue(entry)) as Prisma.InputJsonValue;
    }
    if (typeof value === 'object') {
      const mapped = Object.entries(value as Record<string, unknown>).reduce(
        (acc, [key, val]) => {
          acc[key] = this.toJsonValue(val);
          return acc;
        },
        {} as Record<string, Prisma.InputJsonValue>,
      );
      return mapped as Prisma.InputJsonValue;
    }
    return value as Prisma.InputJsonValue;
  }

  private toUserResponse(
    user: Prisma.UserGetPayload<{
      include: {
        preferences: true;
        permissions: true;
        siteAccess: { include: { site: true } };
      };
    }>,
  ): UserResponse {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      legalAccepted: !!user.legalAcceptedAt,
      legalAcceptedAt: user.legalAcceptedAt,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorEnabledAt: user.twoFactorEnabledAt,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      jobTitle: user.jobTitle,
      isActive: user.isActive,
      failedLoginAttempts: user.failedLoginAttempts ?? 0,
      lastFailedLoginAt: user.lastFailedLoginAt ?? undefined,
      lockedAt: user.lockedAt ?? undefined,
      lockedUntil: user.lockedUntil ?? undefined,
      lockedReason: user.lockedReason ?? undefined,
      lastLoginAt: user.lastLoginAt ?? undefined,
      lastLoginIp: user.lastLoginIp ?? undefined,
      lastLoginCountry: user.lastLoginCountry ?? undefined,
      lastLoginUserAgent: user.lastLoginUserAgent ?? undefined,
      anomalyFlag: user.anomalyFlag ?? false,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      preferences: {
        theme: user.preferences?.theme ?? 'auto',
        density: user.preferences?.density ?? 'compact',
        language: user.preferences?.language ?? 'en',
        timeFormat: user.preferences?.timeFormat ?? '24h',
        notifications: (user.preferences?.notifications as Record<string, unknown> | null) ?? null,
      },
      permissions:
        user.permissions && user.permissions.length > 0
          ? user.permissions.map((perm) => perm.feature).sort()
          : [...(DEFAULT_FEATURES_BY_ROLE[user.role] ?? [])],
      siteAccess:
        user.siteAccess?.map((access) => ({
          siteId: access.siteId,
          level: access.level,
          siteName: access.site?.name ?? null,
        })) ?? [],
    };
  }
}
