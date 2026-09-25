import { apiClient } from './client';

export interface FleetIdentityView {
  fingerprint: string;
  label?: string;
  role?: string;
  source?: string;
}

export interface FleetIdentityRow {
  id: string;
  label: string;
  fingerprint: string;
  role: string;
  source: string;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface FleetTrustRow {
  nodeNum: number;
  name: string;
  adminKeyFingerprints: string[];
  isManaged: boolean;
  lastVerifiedAt: string | null;
  lastVerifyMethod: string | null;
  currentPskFp: string | null;
  strandedSince: string | null;
  driftStatus: string;
}

export interface FleetChannelRow {
  channelIndex: number;
  name: string;
  role: string;
  pskFingerprint: string | null;
  pskLength: number | null;
  lastRotatedAt: string | null;
}

export interface FleetPolicyView {
  expectedAdminKeyFps: string[];
  expectedIsManaged: boolean;
  updatedAt: string;
}

export interface RotationTargetView {
  nodeNum: number;
  phase: string;
  attempts: number;
  lastError?: string;
}

export interface RotationView {
  id: string;
  kind: string;
  channelIndex: number | null;
  stagingChannelIndex: number | null;
  piLocalPhase: string;
  startedAt: string;
  retiredAt: string | null;
  targets: RotationTargetView[];
  newPskFp: string | null;
}

export const getFleetIdentity = () => apiClient.get<FleetIdentityView>('/fleet-security/identity');
export const getFleetIdentities = () =>
  apiClient.get<FleetIdentityRow[]>('/fleet-security/identities');
export const registerFleetIdentity = (body: { label: string; publicKey: string; role: string }) =>
  apiClient.post('/fleet-security/identities', body);
export const revokeFleetIdentity = (fingerprint: string, reason: string) =>
  apiClient.post('/fleet-security/identity/revoke', { fingerprint, reason });

export const getFleetTrust = () => apiClient.get<FleetTrustRow[]>('/fleet-security/trust');
export const verifyFleetNode = (nodeNum: number) =>
  apiClient.post<{ ok: boolean; error?: string }>(`/fleet-security/trust/${nodeNum}/verify`);
export const setFleetAdminKeys = (nodeNum: number, keyFingerprints: string[]) =>
  apiClient.put(`/fleet-security/trust/${nodeNum}/admin-keys`, { keyFingerprints });
export const setFleetIsManaged = (nodeNum: number, value: boolean) =>
  apiClient.put(`/fleet-security/trust/${nodeNum}/is-managed`, { value });

export const getFleetChannels = () => apiClient.get<FleetChannelRow[]>('/fleet-security/channels');
export const refreshFleetChannels = () =>
  apiClient.post<FleetChannelRow[]>('/fleet-security/channels/refresh');

export const getFleetPolicy = () => apiClient.get<FleetPolicyView>('/fleet-security/policy');
export const setFleetPolicy = (body: { expectedIsManaged?: boolean }) =>
  apiClient.put('/fleet-security/policy', body);

export const startRotation = (body: {
  channelIndex: number;
  targets: number[];
  ack: string;
  notes?: string;
}) =>
  apiClient.post<{ rotationId: string; newPskFingerprint: string }>(
    '/fleet-security/rotations',
    body,
  );
export const getRotation = (id: string) =>
  apiClient.get<RotationView>(`/fleet-security/rotations/${id}`);
export const retireRotation = (id: string) =>
  apiClient.post<{ ok: boolean; laggards?: number[] }>(`/fleet-security/rotations/${id}/retire`);
