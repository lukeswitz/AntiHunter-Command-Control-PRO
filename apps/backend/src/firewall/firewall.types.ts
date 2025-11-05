import {
  FirewallConfig,
  FirewallGeoMode,
  FirewallLogOutcome,
  FirewallPolicy,
  FirewallRule,
  FirewallRuleType,
} from '@prisma/client';

export interface FirewallConfigResponse {
  enabled: boolean;
  defaultPolicy: FirewallPolicy;
  geoMode: FirewallGeoMode;
  allowedCountries: string[];
  blockedCountries: string[];
  ipAllowList: string[];
  ipBlockList: string[];
  failThreshold: number;
  failWindowSeconds: number;
  banDurationSeconds: number;
  updatedAt: string;
}

export interface FirewallRuleResponse {
  id: string;
  ip: string;
  type: FirewallRuleType;
  reason?: string | null;
  expiresAt?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FirewallLogResponse {
  id: string;
  ip: string;
  country?: string | null;
  path: string;
  method: string;
  outcome: FirewallLogOutcome;
  ruleId?: string | null;
  attempts: number;
  firstSeen: string;
  lastSeen: string;
  blocked: boolean;
  reason?: string | null;
  userAgent?: string | null;
}

export interface FirewallOverview {
  config: FirewallConfigResponse;
  rules: FirewallRuleResponse[];
  stats: {
    totalRules: number;
    totalBlockedRules: number;
    totalLogs: number;
    blockedLast24h: number;
    authFailuresLast24h: number;
  };
}

export type FirewallConfigEntity = FirewallConfig;
export type FirewallRuleEntity = FirewallRule;
