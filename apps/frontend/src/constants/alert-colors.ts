import type { AppSettings } from '../api/types';

export interface AlertColorConfig {
  idle: string;
  info: string;
  notice: string;
  alert: string;
  critical: string;
}

export const DEFAULT_ALERT_COLORS: AlertColorConfig = {
  idle: '#38BDF8',
  info: '#2563EB',
  notice: '#22C55E',
  alert: '#F97316',
  critical: '#EF4444',
};

export function extractAlertColors(
  settings?: Pick<
    AppSettings,
    | 'alertColorIdle'
    | 'alertColorInfo'
    | 'alertColorNotice'
    | 'alertColorAlert'
    | 'alertColorCritical'
  >,
): AlertColorConfig {
  if (!settings) {
    return { ...DEFAULT_ALERT_COLORS };
  }

  return {
    idle: normalizeHex(settings.alertColorIdle, DEFAULT_ALERT_COLORS.idle),
    info: normalizeHex(settings.alertColorInfo, DEFAULT_ALERT_COLORS.info),
    notice: normalizeHex(settings.alertColorNotice, DEFAULT_ALERT_COLORS.notice),
    alert: normalizeHex(settings.alertColorAlert, DEFAULT_ALERT_COLORS.alert),
    critical: normalizeHex(settings.alertColorCritical, DEFAULT_ALERT_COLORS.critical),
  };
}

function normalizeHex(value: string | null | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const prefixed = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return `#${prefixed.slice(1).toUpperCase()}`;
}
