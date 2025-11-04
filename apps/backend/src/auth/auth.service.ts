import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, Role, SiteAccessLevel } from '@prisma/client';
import * as argon2 from 'argon2';
import { Request } from 'express';
import * as jwt from 'jsonwebtoken';

import { AuthTokenPayload } from './auth.types';
import { LEGAL_DISCLAIMER } from './legal-disclaimer';
import { FirewallService } from '../firewall/firewall.service';
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
}

@Injectable()
export class AuthService {
  private readonly jwtSecret: jwt.Secret = process.env.JWT_SECRET ?? 'command-center-dev-secret';
  private readonly tokenTtl = process.env.JWT_EXPIRY ?? '12h';
  private readonly twoFactorTokenTtl = process.env.TWO_FACTOR_TOKEN_EXPIRY ?? '10m';

  constructor(
    private readonly prisma: PrismaService,
    private readonly firewallService: FirewallService,
  ) {}

  async login(email: string, password: string, req?: Request): Promise<LoginResult> {
    const ip = this.firewallService.getClientIp(req);
    const userAgent = req?.headers['user-agent'] as string | undefined;
    const path = req?.path ?? '/auth/login';
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
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
      if (ip) {
        await this.firewallService.registerAuthFailure(ip, {
          reason: 'INVALID_PASSWORD',
          path,
          userAgent,
        });
      }
      throw new UnauthorizedException('Invalid credentials');
    }

    if (ip) {
      await this.firewallService.registerAuthSuccess(ip, { path, userAgent });
    }

    const legalAccepted = !!user.legalAcceptedAt;

    if (!legalAccepted) {
      const token = this.createToken(user.id, user.email, user.role, false);
      return {
        token,
        user: this.toUserResponse(user),
        legalAccepted: false,
        disclaimer: LEGAL_DISCLAIMER,
      };
    }

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

    const token = this.createToken(user.id, user.email, user.role, legalAccepted);

    return {
      token,
      user: this.toUserResponse(user),
      legalAccepted,
      disclaimer: legalAccepted ? undefined : LEGAL_DISCLAIMER,
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
