import { apiClient } from './client';

export interface RemoteAlertConfig {
  tsAllowedLogins: string[];
  vapidPublicKey: string | null;
  vapidSubject: string | null;
  hasVapidPrivateKey: boolean;
  ntfyEnabled: boolean;
  ntfyUrl: string | null;
  hasNtfyToken: boolean;
  signalEnabled: boolean;
  signalApiUrl: string | null;
  signalNumber: string | null;
  signalRecipients: string[];
  matrixEnabled: boolean;
  matrixHomeserverUrl: string | null;
  hasMatrixAccessToken: boolean;
  matrixRoomId: string | null;
  matterEnabled: boolean;
  matterLayout: 'bridge' | 'flat';
  updatedAt: string;
}

export type RemoteAlertConfigUpdate = Partial<{
  tsAllowedLogins: string[];
  vapidSubject: string;
  ntfyEnabled: boolean;
  ntfyUrl: string;
  ntfyToken: string;
  signalEnabled: boolean;
  signalApiUrl: string;
  signalNumber: string;
  signalRecipients: string[];
  matrixEnabled: boolean;
  matrixHomeserverUrl: string;
  matrixAccessToken: string;
  matrixRoomId: string;
  matterEnabled: boolean;
  matterLayout: 'bridge' | 'flat';
}>;

export interface MatterStatus {
  running: boolean;
  runtime: string;
  commissioned: boolean | null;
  layout: string | null;
  manualPairingCode: string | null;
  qrPairingCode: string | null;
  passcode: number | null;
  lastExit: string | null;
}

export interface PushSubscriptionRow {
  endpoint: string;
  service: string;
  userEmail: string;
  createdAt: string;
}

export type AlertChannel = 'push' | 'ntfy' | 'signal' | 'matrix' | 'matter';

export const getRemoteAlertConfig = () => apiClient.get<RemoteAlertConfig>('/remote-alerts/config');

export const updateRemoteAlertConfig = (body: RemoteAlertConfigUpdate) =>
  apiClient.put<RemoteAlertConfig>('/remote-alerts/config', body);

export const clearRemoteAlertSecret = (field: 'ntfyToken' | 'matrixAccessToken') =>
  apiClient.delete<RemoteAlertConfig>(`/remote-alerts/config/secret/${field}`);

export const generateVapidKeys = () =>
  apiClient.post<{ publicKey: string }>('/remote-alerts/vapid/generate');

export const listPushSubscriptions = () =>
  apiClient.get<PushSubscriptionRow[]>('/remote-alerts/push/subscriptions');

export const removePushSubscription = (endpoint: string) =>
  apiClient.delete('/remote-alerts/push/subscriptions', { body: { endpoint } as never });

export const testAlertChannel = (channel: AlertChannel) =>
  apiClient.post(`/remote-alerts/test/${channel}`);

export const getMatterStatus = () => apiClient.get<MatterStatus>('/remote-alerts/matter/status');

export const restartMatter = () => apiClient.post<MatterStatus>('/remote-alerts/matter/restart');

export const eraseMatter = () => apiClient.post<MatterStatus>('/remote-alerts/matter/erase');
