import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, Role, SiteAccessLevel } from '@prisma/client';
import * as argon2 from 'argon2';
import * as jwt from 'jsonwebtoken';

import { AuthTokenPayload } from './auth.types';
import { LEGAL_DISCLAIMER } from './legal-disclaimer';
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
}

@Injectable()
export class AuthService {
  private readonly jwtSecret: jwt.Secret = process.env.JWT_SECRET ?? 'command-center-dev-secret';
  private readonly tokenTtl = process.env.JWT_EXPIRY ?? '12h';

  constructor(private readonly prisma: PrismaService) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const legalAccepted = !!user.legalAcceptedAt;
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

  private createToken(id: string, email: string, role: Role, legalAccepted: boolean): string {
    const payload: Partial<AuthTokenPayload> = {
      sub: id,
      email,
      role,
      legalAccepted,
    };

    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.tokenTtl as jwt.SignOptions['expiresIn'],
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
