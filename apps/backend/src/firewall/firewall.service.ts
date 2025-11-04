import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FirewallConfig,
  FirewallGeoMode,
  FirewallLogOutcome,
  FirewallPolicy,
  FirewallRule,
  FirewallRuleType,
  Prisma,
} from '@prisma/client';
import { Request } from 'express';
import * as geoip from 'geoip-lite';

import { BlockFirewallLogDto } from './dto/block-firewall-log.dto';
import { CreateFirewallRuleDto } from './dto/create-firewall-rule.dto';
import { ListFirewallLogsDto } from './dto/list-firewall-logs.dto';
import { UpdateFirewallConfigDto } from './dto/update-firewall-config.dto';
import {
  FirewallConfigResponse,
  FirewallLogResponse,
  FirewallOverview,
  FirewallRuleResponse,
} from './firewall.types';
import { PrismaService } from '../prisma/prisma.service';

interface AuthFailureState {
  count: number;
  first: number;
  last: number;
}

@Injectable()
export class FirewallService {
  private readonly logger = new Logger(FirewallService.name);
  private readonly authFailures = new Map<string, AuthFailureState>();
  private readonly localSiteId: string;
  private lastRuleCleanup = 0;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
  }

  async handleRequest(req: Request): Promise<void> {
    const ip = this.getClientIp(req);
    if (!ip) {
      return;
    }

    const config = await this.ensureConfig();
    if (!config.enabled) {
      return;
    }

    await this.cleanupExpiredRules();

    const rule = await this.evaluateRules(ip);
    if (rule?.type === FirewallRuleType.ALLOW) {
      return;
    }
    if (rule) {
      await this.logBlock({
        ip,
        reason: rule.reason ?? 'IP blocked by rule',
        path: req.path,
        method: req.method,
        ruleId: rule.id,
        userAgent: req.headers['user-agent'] as string | undefined,
      });
      throw new FirewallBlockedException('Access denied by firewall (rule)');
    }

    const country = this.lookupCountry(ip);
    if (this.shouldBlockByGeo(config, country)) {
      await this.logBlock({
        ip,
        reason: 'Blocked by geo policy',
        path: req.path,
        method: req.method,
        country,
        outcome: FirewallLogOutcome.GEO_BLOCK,
        userAgent: req.headers['user-agent'] as string | undefined,
      });
      throw new FirewallBlockedException('Access denied by firewall (geo policy)');
    }

    if (config.defaultPolicy === FirewallPolicy.DENY) {
      await this.logBlock({
        ip,
        reason: 'Default deny policy',
        path: req.path,
        method: req.method,
        country,
        outcome: FirewallLogOutcome.DEFAULT_DENY,
        userAgent: req.headers['user-agent'] as string | undefined,
      });
      throw new FirewallBlockedException('Access denied by firewall (default policy)');
    }
  }

  async getOverview(): Promise<FirewallOverview> {
    const [config, rules, totalLogs, blockedLast24h, authFailures24h] = await Promise.all([
      this.ensureConfig(),
      this.prisma.firewallRule.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.firewallLog.count(),
      this.prisma.firewallLog.count({
        where: {
          lastSeen: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.firewallLog.count({
        where: {
          outcome: FirewallLogOutcome.AUTH_FAILURE,
          lastSeen: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    const responses = rules.map((rule) => this.mapRule(rule));
    return {
      config: this.mapConfig(config),
      rules: responses,
      stats: {
        totalRules: rules.length,
        totalBlockedRules: rules.filter((rule) => rule.type !== FirewallRuleType.ALLOW).length,
        totalLogs,
        blockedLast24h,
        authFailuresLast24h: authFailures24h,
      },
    };
  }

  async updateConfig(dto: UpdateFirewallConfigDto): Promise<FirewallConfigResponse> {
    const updateData: Prisma.FirewallConfigUpdateInput = {};
    if (dto.enabled !== undefined) {
      updateData.enabled = dto.enabled;
    }
    if (dto.defaultPolicy !== undefined) {
      updateData.defaultPolicy = dto.defaultPolicy;
    }
    if (dto.geoMode !== undefined) {
      updateData.geoMode = dto.geoMode;
    }
    if (dto.allowedCountries !== undefined) {
      updateData.allowedCountries = this.normalizeCountryList(dto.allowedCountries);
    }
    if (dto.blockedCountries !== undefined) {
      updateData.blockedCountries = this.normalizeCountryList(dto.blockedCountries);
    }
    if (dto.failThreshold !== undefined) {
      updateData.failThreshold = dto.failThreshold;
    }
    if (dto.failWindowSeconds !== undefined) {
      updateData.failWindowSeconds = dto.failWindowSeconds;
    }
    if (dto.banDurationSeconds !== undefined) {
      updateData.banDurationSeconds = dto.banDurationSeconds;
    }

    const config = await this.prisma.firewallConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        enabled: dto.enabled ?? true,
        defaultPolicy: dto.defaultPolicy ?? FirewallPolicy.ALLOW,
        geoMode: dto.geoMode ?? FirewallGeoMode.DISABLED,
        allowedCountries: this.normalizeCountryList(dto.allowedCountries),
        blockedCountries: this.normalizeCountryList(dto.blockedCountries),
        failThreshold: dto.failThreshold ?? 5,
        failWindowSeconds: dto.failWindowSeconds ?? 900,
        banDurationSeconds: dto.banDurationSeconds ?? 3600,
      },
      update: updateData,
    });

    return this.mapConfig(config);
  }

  async listRules(): Promise<FirewallRuleResponse[]> {
    await this.cleanupExpiredRules();
    const rules = await this.prisma.firewallRule.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rules.map((rule) => this.mapRule(rule));
  }

  async createRule(dto: CreateFirewallRuleDto, createdBy?: string): Promise<FirewallRuleResponse> {
    const ip = this.normalizeIp(dto.ip);
    if (!ip) {
      throw new ForbiddenException('Invalid IP address');
    }

    if (dto.type === FirewallRuleType.ALLOW) {
      // Remove existing block rules for this IP to avoid conflicts.
      await this.prisma.firewallRule.deleteMany({
        where: { ip, type: { in: [FirewallRuleType.BLOCK, FirewallRuleType.TEMP_BLOCK] } },
      });
    }

    const expiresAt =
      dto.type !== FirewallRuleType.ALLOW && dto.durationSeconds
        ? new Date(Date.now() + dto.durationSeconds * 1000)
        : null;

    const rule = await this.prisma.firewallRule.create({
      data: {
        ip,
        type: dto.type,
        reason: dto.reason ?? null,
        expiresAt,
        createdBy: createdBy ?? null,
      },
    });

    return this.mapRule(rule);
  }

  async deleteRule(id: string): Promise<void> {
    await this.prisma.firewallRule.delete({
      where: { id },
    });
  }

  async listLogs(dto: ListFirewallLogsDto): Promise<FirewallLogResponse[]> {
    const limit = dto.limit ?? 50;
    const where: Prisma.FirewallLogWhereInput = {};
    if (dto.outcome) {
      where.outcome = dto.outcome;
    }
    if (dto.onlyBlocked) {
      where.blocked = true;
    }
    if (dto.search) {
      where.OR = [
        { ip: { contains: dto.search, mode: 'insensitive' } },
        { reason: { contains: dto.search, mode: 'insensitive' } },
      ];
    }

    const logs = await this.prisma.firewallLog.findMany({
      where,
      orderBy: { lastSeen: 'desc' },
      take: limit,
    });
    return logs.map((log) => this.mapLog(log));
  }

  async blockFromLog(id: string, dto: BlockFirewallLogDto, createdBy?: string) {
    const log = await this.prisma.firewallLog.findUnique({ where: { id } });
    if (!log) {
      throw new ForbiddenException('Log entry not found');
    }
    return this.blockIp(log.ip, {
      type: dto.type ?? FirewallRuleType.BLOCK,
      reason: dto.reason ?? `Manual block from log ${id}`,
      durationSeconds: dto.durationSeconds,
      createdBy,
    });
  }

  async blockIp(
    ip: string,
    options: {
      type?: FirewallRuleType;
      reason?: string;
      durationSeconds?: number;
      createdBy?: string;
    } = {},
  ): Promise<FirewallRuleResponse> {
    const ruleDto: CreateFirewallRuleDto = {
      ip,
      type: options.type ?? FirewallRuleType.BLOCK,
      reason: options.reason,
      durationSeconds: options.durationSeconds,
    };
    return this.createRule(ruleDto, options.createdBy);
  }

  async registerAuthFailure(
    ip: string,
    context: { reason?: string; path?: string; userAgent?: string },
  ): Promise<void> {
    const normalizedIp = this.normalizeIp(ip);
    if (!normalizedIp) {
      return;
    }

    const config = await this.ensureConfig();
    const now = Date.now();
    const current = this.authFailures.get(normalizedIp);

    if (!current || now - current.first > config.failWindowSeconds * 1000) {
      this.authFailures.set(normalizedIp, { count: 1, first: now, last: now });
    } else {
      current.count += 1;
      current.last = now;
      this.authFailures.set(normalizedIp, current);
    }

    await this.logEvent({
      ip: normalizedIp,
      outcome: FirewallLogOutcome.AUTH_FAILURE,
      path: context.path,
      method: 'POST',
      reason: context.reason ?? 'Authentication failure',
      userAgent: context.userAgent,
      blocked: false,
    });

    const state = this.authFailures.get(normalizedIp);
    if (state && state.count >= config.failThreshold) {
      this.logger.warn(`Blocking IP ${normalizedIp} due to repeated authentication failures.`);
      const rule = await this.blockIp(normalizedIp, {
        type: FirewallRuleType.TEMP_BLOCK,
        reason: 'Too many failed login attempts',
        durationSeconds: config.banDurationSeconds,
        createdBy: 'system',
      });
      this.authFailures.delete(normalizedIp);
      await this.logBlock({
        ip: normalizedIp,
        reason: 'Too many failed login attempts',
        path: context.path ?? '/auth/login',
        method: 'POST',
        ruleId: rule.id,
        country: this.lookupCountry(normalizedIp),
        userAgent: context.userAgent,
      });
    }
  }

  async registerAuthSuccess(
    ip: string,
    context: { path?: string; userAgent?: string } = {},
  ): Promise<void> {
    const normalizedIp = this.normalizeIp(ip);
    if (!normalizedIp) {
      return;
    }
    this.authFailures.delete(normalizedIp);
    await this.logEvent({
      ip: normalizedIp,
      outcome: FirewallLogOutcome.AUTH_SUCCESS,
      path: context.path,
      method: 'POST',
      blocked: false,
      reason: 'Authentication success',
      userAgent: context.userAgent,
    });
  }

  getClientIp(req?: Request | null): string | null {
    if (!req) {
      return null;
    }
    const forwarded = req.headers['x-forwarded-for'];
    let candidate: string | undefined;
    if (Array.isArray(forwarded)) {
      candidate = forwarded[0];
    } else if (typeof forwarded === 'string' && forwarded.length > 0) {
      candidate = forwarded.split(',')[0];
    }
    if (!candidate) {
      candidate =
        req.ip ||
        (req.connection && 'remoteAddress' in req.connection
          ? req.connection.remoteAddress
          : undefined) ||
        (req.socket && 'remoteAddress' in req.socket ? req.socket.remoteAddress : undefined) ||
        undefined;
    }
    return this.normalizeIp(candidate ?? null);
  }

  private async ensureConfig(): Promise<FirewallConfig> {
    return this.prisma.firewallConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
      },
      update: {},
    });
  }

  private async evaluateRules(ip: string): Promise<FirewallRule | null> {
    const rules = await this.prisma.firewallRule.findMany({
      where: { ip },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    for (const rule of rules) {
      if (rule.expiresAt && rule.expiresAt < now) {
        await this.prisma.firewallRule.delete({ where: { id: rule.id } });
        continue;
      }
      if (rule.type === FirewallRuleType.ALLOW) {
        return rule;
      }
      if (rule.type === FirewallRuleType.BLOCK || rule.type === FirewallRuleType.TEMP_BLOCK) {
        return rule;
      }
    }
    return null;
  }

  private shouldBlockByGeo(config: FirewallConfig, country?: string | null): boolean {
    if (config.geoMode === FirewallGeoMode.DISABLED) {
      return false;
    }
    const normalizedCountry = country?.toUpperCase();
    if (config.geoMode === FirewallGeoMode.ALLOW_LIST) {
      if (!normalizedCountry) {
        return true;
      }
      return !config.allowedCountries.includes(normalizedCountry);
    }
    if (config.geoMode === FirewallGeoMode.BLOCK_LIST) {
      if (!normalizedCountry) {
        return false;
      }
      return config.blockedCountries.includes(normalizedCountry);
    }
    return false;
  }

  private lookupCountry(ip: string): string | undefined {
    try {
      const lookup = geoip.lookup(ip);
      return lookup?.country?.toUpperCase();
    } catch (error) {
      this.logger.warn(`Unable to resolve geo IP for ${ip}: ${error}`);
      return undefined;
    }
  }

  private normalizeCountryList(values?: string[] | null): string[] {
    if (!values) {
      return [];
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    values.forEach((value) => {
      const code = value.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(code) && !seen.has(code)) {
        seen.add(code);
        normalized.push(code);
      }
    });
    return normalized;
  }

  private normalizeIp(ip: string | null | undefined): string | null {
    if (!ip) {
      return null;
    }
    let normalized = ip.trim();
    if (normalized.startsWith('::ffff:')) {
      normalized = normalized.substring(7);
    }
    if (normalized === '::1') {
      normalized = '127.0.0.1';
    }
    return normalized;
  }

  private async logBlock(details: {
    ip: string;
    reason: string;
    path: string;
    method: string;
    outcome?: FirewallLogOutcome;
    country?: string;
    ruleId?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.logEvent({
      ip: details.ip,
      outcome: details.outcome ?? FirewallLogOutcome.BLOCKED,
      path: details.path,
      method: details.method,
      reason: details.reason,
      country: details.country,
      ruleId: details.ruleId,
      blocked: true,
      userAgent: details.userAgent,
    });
  }

  private async logEvent(event: {
    ip: string;
    outcome: FirewallLogOutcome;
    path?: string;
    method?: string;
    ruleId?: string | null;
    reason?: string;
    country?: string;
    blocked?: boolean;
    userAgent?: string;
  }): Promise<void> {
    const path = event.path ? event.path.substring(0, 128) : '*';
    const method = event.method ? event.method.toUpperCase().substring(0, 16) : 'UNKNOWN';

    await this.prisma.firewallLog.upsert({
      where: {
        ip_outcome_path: {
          ip: event.ip,
          outcome: event.outcome,
          path,
        },
      },
      create: {
        ip: event.ip,
        outcome: event.outcome,
        path,
        method,
        ruleId: event.ruleId ?? null,
        reason: event.reason ?? null,
        country: event.country ?? null,
        blocked: event.blocked ?? false,
        siteId: this.localSiteId,
        userAgent: event.userAgent ?? null,
      },
      update: {
        attempts: { increment: 1 },
        lastSeen: new Date(),
        method,
        ruleId: event.ruleId ?? null,
        reason: event.reason ?? null,
        country: event.country ?? null,
        blocked: event.blocked ?? false,
        userAgent: event.userAgent ?? null,
        siteId: this.localSiteId,
      },
    });
  }

  private mapConfig(config: FirewallConfig): FirewallConfigResponse {
    return {
      enabled: config.enabled,
      defaultPolicy: config.defaultPolicy,
      geoMode: config.geoMode,
      allowedCountries: config.allowedCountries ?? [],
      blockedCountries: config.blockedCountries ?? [],
      failThreshold: config.failThreshold,
      failWindowSeconds: config.failWindowSeconds,
      banDurationSeconds: config.banDurationSeconds,
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  private mapRule(rule: FirewallRule): FirewallRuleResponse {
    return {
      id: rule.id,
      ip: rule.ip,
      type: rule.type,
      reason: rule.reason ?? null,
      expiresAt: rule.expiresAt ? rule.expiresAt.toISOString() : null,
      createdBy: rule.createdBy ?? null,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  private mapLog(log: Prisma.FirewallLogGetPayload<Record<string, never>>): FirewallLogResponse {
    return {
      id: log.id,
      ip: log.ip,
      country: log.country ?? null,
      path: log.path,
      method: log.method,
      outcome: log.outcome,
      ruleId: log.ruleId ?? null,
      attempts: log.attempts,
      firstSeen: log.firstSeen.toISOString(),
      lastSeen: log.lastSeen.toISOString(),
      blocked: log.blocked,
      reason: log.reason ?? null,
      userAgent: log.userAgent ?? null,
    };
  }

  private async cleanupExpiredRules(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRuleCleanup < 60_000) {
      return;
    }
    this.lastRuleCleanup = now;
    await this.prisma.firewallRule.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
  }
}

export class FirewallBlockedException extends ForbiddenException {
  constructor(message: string) {
    super(message);
  }
}
