import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role, SiteAccessLevel } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateCurrentUserDto } from './dto/update-current-user.dto';
import { UpdateUserPermissionsDto } from './dto/update-user-permissions.dto';
import { UpdateUserSiteAccessDto } from './dto/update-user-site-access.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  DEFAULT_FEATURES_BY_ROLE,
  FEATURE_FLAGS,
  FeatureFlagDefinition,
  isValidFeatureKey,
} from './user-permissions.constants';

interface PreferenceDto {
  theme: string;
  density: string;
  language: string;
  timeFormat: string;
  notifications: Record<string, unknown> | null;
}

interface SiteAccessDto {
  siteId: string;
  level: SiteAccessLevel;
  siteName?: string | null;
}

interface UserInvitationDto {
  id: string;
  email: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt?: Date | null;
}

export interface UserDto {
  id: string;
  email: string;
  role: Role;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  isActive: boolean;
  legalAccepted: boolean;
  createdAt: Date;
  updatedAt: Date;
  preferences: PreferenceDto;
  permissions: string[];
  siteAccess: SiteAccessDto[];
}

export interface UserDetailDto extends UserDto {
  pendingInvitations: UserInvitationDto[];
}

export interface AuditEntryDto {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: Date;
  userId?: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
}

interface PreferenceUpdateData {
  theme?: string;
  density?: string;
  language?: string;
  timeFormat?: string;
  notifications?: Prisma.InputJsonValue;
}

const PASSWORD_RESET_TOKEN_BYTES = 32;
const INVITATION_TOKEN_BYTES = 32;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  // #region Public getters
  getFeatureFlags(): FeatureFlagDefinition[] {
    return FEATURE_FLAGS;
  }

  async getCurrentUser(userId: string): Promise<UserDto> {
    const user = await this.findUserOrThrow(userId);
    return this.mapUser(user);
  }

  async getUserDetails(userId: string): Promise<UserDetailDto> {
    const user = await this.findUserOrThrow(userId);
    const invitations = await this.prisma.userInvitation.findMany({
      where: { email: user.email.toLowerCase(), acceptedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ...this.mapUser(user),
      pendingInvitations: invitations.map((invite) => ({
        id: invite.id,
        email: invite.email,
        token: invite.token,
        expiresAt: invite.expiresAt,
        createdAt: invite.createdAt,
        acceptedAt: invite.acceptedAt,
      })),
    };
  }

  async listUsers(dto: ListUsersDto): Promise<UserDto[]> {
    const includeInactive = dto.includeInactive === 'true';
    const where: Prisma.UserWhereInput = {};
    if (!includeInactive) {
      where.isActive = true;
    }
    if (dto.search?.trim()) {
      const term = dto.search.trim();
      where.OR = [
        { email: { contains: term, mode: 'insensitive' } },
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((user) => this.mapUser(user));
  }

  async listUserAudit(userId: string, take: number): Promise<AuditEntryDto[]> {
    const user = await this.findUserOrThrow(userId);
    const entries = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { entity: 'User', entityId: userId },
          { entity: 'UserInvitation', entityId: user.email.toLowerCase() },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take,
    });

    return entries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      entity: entry.entity ?? 'User',
      entityId: entry.entityId ?? '',
      createdAt: entry.createdAt,
      userId: entry.userId,
      before: entry.before,
      after: entry.after,
    }));
  }
  // #endregion

  // #region Mutations
  async updateCurrentUser(userId: string, dto: UpdateCurrentUserDto): Promise<UserDto> {
    const { userData, preferenceData } = this.extractProfileUpdate(dto);

    if (userData.email) {
      const nextEmail = userData.email as string;
      const existing = await this.prisma.user.findUnique({ where: { email: nextEmail } });
      if (existing && existing.id !== userId) {
        throw new BadRequestException('Email already registered');
      }
    }

    if (Object.keys(userData).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: userData,
      });
    }

    if (preferenceData) {
      const createData: Prisma.UserPreferenceUncheckedCreateInput = {
        userId,
        ...preferenceData,
      };
      const updateData: Prisma.UserPreferenceUncheckedUpdateInput = {
        ...preferenceData,
      };
      await this.prisma.userPreference.upsert({
        where: { userId },
        create: createData,
        update: updateData,
      });
    }

    return this.getCurrentUser(userId);
  }

  async createUser(dto: CreateUserDto, actorId?: string): Promise<UserDto> {
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new BadRequestException('Email already registered');
    }

    const passwordHash = await argon2.hash(dto.password);
    const defaultFeatures = DEFAULT_FEATURES_BY_ROLE[dto.role] ?? [];
    const featureSet = dto.permissions?.length
      ? this.normalizeFeatureSet(dto.permissions)
      : defaultFeatures;

    const siteAssignments = dto.siteAccess ?? [];

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        role: dto.role,
        firstName: dto.firstName?.trim() || null,
        lastName: dto.lastName?.trim() || null,
        phone: dto.phone?.trim() || null,
        jobTitle: dto.jobTitle?.trim() || null,
        isActive: dto.isActive ?? true,
        preferences: {
          create: {
            theme: 'auto',
            density: 'compact',
            language: 'en',
            timeFormat: dto.timeFormat ?? '24h',
          },
        },
        permissions: {
          create: featureSet.map((feature) => ({ feature })),
        },
        siteAccess: {
          create: siteAssignments.map((assignment) => ({
            siteId: assignment.siteId,
            level: assignment.level,
          })),
        },
      },
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
    });

    await this.writeAudit(actorId, 'USER_CREATE', user.id, null, {
      email: user.email,
      role: user.role,
      permissions: featureSet,
      siteAccess: siteAssignments,
    });

    return this.mapUser(user);
  }

  async updateUser(id: string, dto: UpdateUserDto, actorId: string): Promise<UserDto> {
    if (id === actorId && dto.role && dto.role !== Role.ADMIN) {
      throw new ForbiddenException('You cannot change your own role');
    }

    const data: Prisma.UserUpdateInput = {};
    const preferenceUpdates: PreferenceUpdateData = {};
    if (dto.email !== undefined) {
      const email = dto.email.toLowerCase();
      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing && existing.id !== id) {
        throw new BadRequestException('Email already registered');
      }
      data.email = email;
    }
    if (dto.role !== undefined) {
      data.role = dto.role;
    }
    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }
    if (dto.firstName !== undefined) {
      data.firstName = dto.firstName?.trim() || null;
    }
    if (dto.lastName !== undefined) {
      data.lastName = dto.lastName?.trim() || null;
    }
    if (dto.phone !== undefined) {
      data.phone = dto.phone?.trim() || null;
    }
    if (dto.jobTitle !== undefined) {
      data.jobTitle = dto.jobTitle?.trim() || null;
    }
    if (dto.timeFormat !== undefined) {
      preferenceUpdates.timeFormat = dto.timeFormat;
    }
    if (dto.password !== undefined) {
      data.passwordHash = await argon2.hash(dto.password);
    }

    let user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (Object.keys(data).length > 0) {
      user = await this.prisma.user.update({
        where: { id },
        data,
        include: {
          preferences: true,
          permissions: true,
          siteAccess: { include: { site: true } },
        },
      });
    }

    if (Object.keys(preferenceUpdates).length > 0) {
      const createData: Prisma.UserPreferenceUncheckedCreateInput = {
        userId: id,
        ...preferenceUpdates,
      };
      const updateData: Prisma.UserPreferenceUncheckedUpdateInput = {
        ...preferenceUpdates,
      };
      await this.prisma.userPreference.upsert({
        where: { userId: id },
        create: createData,
        update: updateData,
      });
      user =
        (await this.prisma.user.findUnique({
          where: { id },
          include: {
            preferences: true,
            permissions: true,
            siteAccess: { include: { site: true } },
          },
        })) ?? user;
    }

    const auditPayload = { ...dto } as Record<string, unknown>;
    if (auditPayload.password) {
      auditPayload.password = '***';
    }
    await this.writeAudit(actorId, 'USER_UPDATE', id, null, auditPayload);

    return this.mapUser(user);
  }

  async disableUser(id: string, actorId: string): Promise<UserDto> {
    if (id === actorId) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
    });

    await this.writeAudit(actorId, 'USER_DISABLE', id, null, { isActive: false });

    return this.mapUser(user);
  }

  async updateUserPermissions(userId: string, dto: UpdateUserPermissionsDto, actorId: string) {
    await this.findUserOrThrow(userId);
    const featureSet = this.normalizeFeatureSet(dto.features);

    await this.prisma.$transaction(async (tx) => {
      if (featureSet.length === 0) {
        await tx.userPermission.deleteMany({ where: { userId } });
        return;
      }

      await tx.userPermission.deleteMany({
        where: {
          userId,
          NOT: { feature: { in: featureSet } },
        },
      });
      const existing = await tx.userPermission.findMany({ where: { userId } });
      const existingSet = new Set(existing.map((perm) => perm.feature));
      const creates = featureSet.filter((feature) => !existingSet.has(feature));
      if (creates.length > 0) {
        await tx.userPermission.createMany({
          data: creates.map((feature) => ({ userId, feature })),
        });
      }
    });

    await this.writeAudit(actorId, 'USER_PERMISSIONS_UPDATE', userId, null, {
      permissions: featureSet,
    });

    return this.getUserDetails(userId);
  }

  async updateUserSiteAccess(userId: string, dto: UpdateUserSiteAccessDto, actorId: string) {
    await this.findUserOrThrow(userId);
    const assignments = dto.siteAccess ?? [];

    await this.prisma.$transaction(async (tx) => {
      if (assignments.length === 0) {
        await tx.userSiteAccess.deleteMany({ where: { userId } });
        return;
      }

      await tx.userSiteAccess.deleteMany({
        where: {
          userId,
          NOT: { siteId: { in: assignments.map((assignment) => assignment.siteId) } },
        },
      });

      for (const assignment of assignments) {
        await tx.userSiteAccess.upsert({
          where: { userId_siteId: { userId, siteId: assignment.siteId } },
          create: { userId, siteId: assignment.siteId, level: assignment.level },
          update: { level: assignment.level },
        });
      }
    });

    await this.writeAudit(actorId, 'USER_SITE_ACCESS_UPDATE', userId, null, assignments);

    return this.getUserDetails(userId);
  }

  async sendPasswordReset(userId: string, actorId: string) {
    const user = await this.findUserOrThrow(userId);
    const token = this.generateToken(PASSWORD_RESET_TOKEN_BYTES);
    const expiresAt = this.futureDateHours(
      this.configService.get<number>('security.passwordResetExpiryHours', 4),
    );

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    const baseUrl = (
      this.configService.get<string>('security.appUrl') ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;

    await this.mailService.sendMail({
      to: user.email,
      subject: 'Command Center password reset',
      text: [
        'A password reset was requested for your Command Center account.',
        `If you made this request, use the link below to reset your password (expires ${expiresAt.toUTCString()}).`,
        resetUrl,
        '',
        'If you did not request this, you can ignore this email.',
      ].join('\n'),
    });

    await this.writeAudit(actorId, 'USER_PASSWORD_RESET_SENT', userId, null, {
      expiresAt,
    });
  }

  async createInvitation(dto: CreateInvitationDto, actorId: string) {
    const email = dto.email.toLowerCase();
    const token = this.generateToken(INVITATION_TOKEN_BYTES);
    const expiresAt = this.futureDateHours(
      this.configService.get<number>('security.invitationExpiryHours', 48),
    );

    const featureSet = dto.permissions?.length
      ? this.normalizeFeatureSet(dto.permissions)
      : (DEFAULT_FEATURES_BY_ROLE[dto.role] ?? []);

    const invitation = await this.prisma.userInvitation.create({
      data: {
        email,
        role: dto.role,
        token,
        expiresAt,
        message: dto.message ?? null,
        inviterId: actorId,
        siteIds: dto.siteIds ?? [],
        permissions: featureSet,
      },
    });

    const baseUrl = (
      this.configService.get<string>('security.appUrl') ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    const acceptUrl = `${baseUrl}/accept-invite?token=${token}`;

    const bodyLines: string[] = [
      'You have been invited to the AntiHunter Command Center.',
      `Role: ${dto.role}`,
    ];
    if (featureSet.length > 0) {
      bodyLines.push(`Features: ${featureSet.join(', ')}`);
    }
    if (dto.siteIds?.length) {
      bodyLines.push(`Site access: ${dto.siteIds.join(', ')}`);
    }
    if (dto.message?.trim()) {
      bodyLines.push('', dto.message.trim());
    }
    bodyLines.push(
      '',
      `Accept this invitation before ${expiresAt.toUTCString()} using the link below:`,
      acceptUrl,
      '',
      'If you were not expecting this invitation you can ignore this message.',
    );

    await this.mailService.sendMail({
      to: email,
      subject: 'AntiHunter Command Center invitation',
      text: bodyLines.join('\n'),
    });

    await this.writeAudit(
      actorId,
      'USER_INVITATION_SENT',
      email,
      null,
      {
        ...dto,
        permissions: featureSet,
        token: '***',
        expiresAt: expiresAt.toISOString(),
      },
      'UserInvitation',
    );

    return invitation;
  }
  // #endregion

  // #region Helpers
  private async findUserOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        preferences: true,
        permissions: true,
        siteAccess: { include: { site: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private mapUser(
    user: Prisma.UserGetPayload<{
      include: {
        preferences: true;
        permissions: true;
        siteAccess: { include: { site: true } };
      };
    }>,
  ): UserDto {
    const preferenceRecord = user.preferences;

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      jobTitle: user.jobTitle,
      isActive: user.isActive,
      legalAccepted: user.legalAcceptedAt != null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      preferences: {
        theme: preferenceRecord?.theme ?? 'auto',
        density: preferenceRecord?.density ?? 'compact',
        language: preferenceRecord?.language ?? 'en',
        timeFormat: preferenceRecord?.timeFormat ?? '24h',
        notifications:
          (preferenceRecord?.notifications as Record<string, unknown> | null | undefined) ?? null,
      },
      permissions:
        user.permissions && user.permissions.length > 0
          ? user.permissions.map((perm) => perm.feature).sort()
          : [...(DEFAULT_FEATURES_BY_ROLE[user.role] ?? [])],
      siteAccess: user.siteAccess.map((access) => ({
        siteId: access.siteId,
        level: access.level,
        siteName: access.site?.name ?? null,
      })),
    };
  }

  private normalizeFeatureSet(features: string[]): string[] {
    const normalized = Array.from(
      new Set(features.map((feature) => feature.trim()).filter((feature) => feature.length > 0)),
    );
    const invalid = normalized.filter((feature) => !isValidFeatureKey(feature));
    if (invalid.length > 0) {
      throw new BadRequestException(`Invalid feature keys: ${invalid.join(', ')}`);
    }
    return normalized;
  }

  private extractProfileUpdate(dto: UpdateCurrentUserDto): {
    userData: Prisma.UserUpdateInput;
    preferenceData?: PreferenceUpdateData;
  } {
    const userData: Prisma.UserUpdateInput = {};

    if (dto.email !== undefined) {
      userData.email = dto.email.toLowerCase();
    }
    if (dto.firstName !== undefined) {
      userData.firstName = dto.firstName.trim() || null;
    }
    if (dto.lastName !== undefined) {
      userData.lastName = dto.lastName.trim() || null;
    }
    if (dto.phone !== undefined) {
      userData.phone = dto.phone.trim() || null;
    }
    if (dto.jobTitle !== undefined) {
      userData.jobTitle = dto.jobTitle.trim() || null;
    }

    const preferenceData: PreferenceUpdateData = {};
    if (dto.theme !== undefined) {
      preferenceData.theme = dto.theme;
    }
    if (dto.density !== undefined) {
      preferenceData.density = dto.density;
    }
    if (dto.language !== undefined) {
      preferenceData.language = dto.language;
    }
    if (dto.timeFormat !== undefined) {
      preferenceData.timeFormat = dto.timeFormat;
    }
    if (dto.notifications !== undefined) {
      preferenceData.notifications = dto.notifications as Prisma.InputJsonValue;
    }

    return {
      userData,
      preferenceData: Object.keys(preferenceData).length > 0 ? preferenceData : undefined,
    };
  }

  private generateToken(length: number): string {
    return randomBytes(length).toString('hex');
  }

  private futureDateHours(hours: number): Date {
    const date = new Date();
    date.setHours(date.getHours() + hours);
    return date;
  }

  private async writeAudit(
    actorId: string | undefined,
    action: string,
    entityId: string,
    before: unknown,
    after: unknown,
    entity: string = 'User',
  ) {
    await this.prisma.auditLog.create({
      data: {
        userId: actorId ?? null,
        action,
        entity,
        entityId,
        before: this.toJsonValue(before),
        after: this.toJsonValue(after),
      },
    });
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    if (value === null || value === undefined) {
      return Prisma.JsonNull;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.toJsonValue(item)) as Prisma.InputJsonValue;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        this.toJsonValue(val),
      ]);
      return Object.fromEntries(entries) as Prisma.InputJsonValue;
    }
    return value as Prisma.InputJsonValue;
  }
  // #endregion
}
