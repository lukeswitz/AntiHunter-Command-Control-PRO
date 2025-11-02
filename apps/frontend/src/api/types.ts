export interface InventoryDevice {
  mac: string;
  vendor?: string | null;
  type?: string | null;
  ssid?: string | null;
  hits: number;
  lastSeen?: string | null;
  maxRSSI?: number | null;
  minRSSI?: number | null;
  avgRSSI?: number | null;
  locallyAdministered: boolean;
  multicast: boolean;
  lastNodeId?: string | null;
  lastLat?: number | null;
  lastLon?: number | null;
  siteId?: string | null;
}

export interface CommandRequest {
  target: string;
  name: string;
  params: string[];
  siteId?: string;
}

export interface CommandResponse {
  id: string;
  status: string;
}

export type AlarmLevel = 'INFO' | 'NOTICE' | 'ALERT' | 'CRITICAL';

export interface AlarmConfig {
  audioPack: string;
  volumeInfo: number;
  volumeNotice: number;
  volumeAlert: number;
  volumeCritical: number;
  gapInfoMs: number;
  gapNoticeMs: number;
  gapAlertMs: number;
  gapCriticalMs: number;
  dndStart?: string | null;
  dndEnd?: string | null;
  backgroundAllowed: boolean;
}

export interface AlarmSettingsResponse {
  config: AlarmConfig;
  sounds: Record<AlarmLevel, string | null>;
}

export type TargetStatus = 'ACTIVE' | 'TRIANGULATING' | 'RESOLVED';

export interface Target {
  id: string;
  name?: string | null;
  mac?: string | null;
  lat: number;
  lon: number;
  url?: string | null;
  notes?: string | null;
  tags: string[];
  siteId?: string | null;
  createdBy?: string | null;
  deviceType?: string | null;
  trackingConfidence?: number | null;
  firstNodeId?: string | null;
  status: TargetStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  id: number;
  appName: string;
  protocol: string;
  timezone?: string | null;
  env: string;
  detectChannels: string;
  detectMode: number;
  detectScanSecs: number;
  allowForever: boolean;
  baselineSecs: number;
  deviceScanSecs: number;
  droneSecs: number;
  deauthSecs: number;
  randomizeSecs: number;
  defaultRadiusM: number;
  mapTileUrl: string;
  mapAttribution: string;
  minZoom: number;
  maxZoom: number;
  alertColorIdle: string;
  alertColorInfo: string;
  alertColorNotice: string;
  alertColorAlert: string;
  alertColorCritical: string;
  mailEnabled: boolean;
  mailHost?: string | null;
  mailPort?: number | null;
  mailSecure: boolean;
  mailUser?: string | null;
  mailFrom: string;
  mailPreview: boolean;
  securityAppUrl: string;
  invitationExpiryHours: number;
  passwordResetExpiryHours: number;
  mailPasswordSet: boolean;
  updatedAt: string;
}

export interface SerialConfig {
  siteId: string;
  devicePath?: string | null;
  baud?: number | null;
  dataBits?: number | null;
  parity?: string | null;
  stopBits?: number | null;
  delimiter?: string | null;
  reconnectBaseMs?: number | null;
  reconnectMaxMs?: number | null;
  reconnectJitter?: number | null;
  reconnectMaxAttempts?: number | null;
  enabled: boolean;
  updatedAt: string;
}

export interface RuntimeConfig {
  env: string;
  siteId: string;
  mqtt: {
    enabled: boolean;
    commandsEnabled: boolean;
    namespace: string;
  };
}

export interface SiteSummary {
  id: string;
  name: string;
  color: string;
  region?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerialState {
  connected: boolean;
  path?: string | null;
  baudRate?: number | null;
  lastError?: string | null;
  protocol?: string | null;
}

export type TakProtocol = 'UDP' | 'TCP' | 'HTTPS';

export interface TakConfig {
  id: number;
  enabled: boolean;
  protocol: TakProtocol;
  host?: string | null;
  port?: number | null;
  tlsEnabled: boolean;
  cafile?: string | null;
  certfile?: string | null;
  keyfile?: string | null;
  username?: string | null;
  password?: string | null;
  apiKey?: string | null;
  streamNodes: boolean;
  streamTargets: boolean;
  streamCommandAcks: boolean;
  streamCommandResults: boolean;
  streamAlertInfo: boolean;
  streamAlertNotice: boolean;
  streamAlertAlert: boolean;
  streamAlertCritical: boolean;
  lastConnected?: string | null;
  updatedAt: string;
}

export interface MqttSiteConfig {
  siteId: string;
  brokerUrl: string;
  clientId: string;
  username?: string | null;
  tlsEnabled: boolean;
  qosEvents: number;
  qosCommands: number;
  enabled: boolean;
  caPem?: string | null;
  certPem?: string | null;
  keyPem?: string | null;
  updatedAt: string;
  site?: {
    id: string;
    name: string;
    color: string;
  };
}

export type MqttStatusState = 'not_configured' | 'disabled' | 'connecting' | 'connected' | 'error';

export interface MqttSiteStatus {
  siteId: string;
  state: MqttStatusState;
  message?: string;
  updatedAt?: string;
}

export interface MqttTestResponse {
  ok: boolean;
  state: MqttStatusState;
  message: string;
}

export type SiteAccessLevel = 'VIEW' | 'MANAGE';

export interface FeatureFlagDefinition {
  key: string;
  label: string;
  description: string;
  defaultForRoles: UserRole[];
}

export interface UserSiteAccessGrant {
  siteId: string;
  level: SiteAccessLevel;
  siteName?: string | null;
}

export interface UserInvitationSummary {
  id: string;
  email: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt?: string | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
  userId?: string | null;
  before?: unknown;
  after?: unknown;
}

export type UserRole = 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER';

export interface UserPreferences {
  theme: string;
  density: string;
  language: string;
  timeFormat: '12h' | '24h';
  notifications?: Record<string, unknown> | null;
}

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  isActive: boolean;
  legalAccepted: boolean;
  legalAcceptedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  preferences: UserPreferences;
  permissions: string[];
  siteAccess: UserSiteAccessGrant[];
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
  legalAccepted: boolean;
  disclaimer?: string;
}

export interface MeResponse {
  user: AuthUser;
  legalAccepted: boolean;
  disclaimer?: string;
}

export interface UserSummary extends AuthUser {}

export interface UserDetail extends AuthUser {
  pendingInvitations: UserInvitationSummary[];
}
