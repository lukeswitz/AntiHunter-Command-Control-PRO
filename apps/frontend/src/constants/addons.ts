const STRATEGY_ADDON_STORAGE_KEY = 'feature.strategyAdvisor.enabled';
const STRATEGY_ADDON_EVENT = 'strategy-addon-change';
const ALERTS_ADDON_STORAGE_KEY = 'feature.alerts.enabled';
const ALERTS_ADDON_EVENT = 'alerts-addon-change';
const SCHEDULER_ADDON_STORAGE_KEY = 'feature.scheduler.enabled';
const SCHEDULER_ADDON_EVENT = 'scheduler-addon-change';
const CHAT_ADDON_STORAGE_KEY = 'feature.chat.enabled';
const CHAT_ADDON_EVENT = 'chat-addon-change';

function getBooleanFlag(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  if (value === null) {
    return fallback;
  }
  return value === 'true';
}

function setBooleanFlag(key: string, eventName: string, value: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(key, value ? 'true' : 'false');
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail: { enabled: value },
    }),
  );
}

export function getStrategyAddonEnabled(): boolean {
  return getBooleanFlag(STRATEGY_ADDON_STORAGE_KEY, false);
}

export function setStrategyAddonEnabled(enabled: boolean): void {
  setBooleanFlag(STRATEGY_ADDON_STORAGE_KEY, STRATEGY_ADDON_EVENT, enabled);
}

export function getAlertsAddonEnabled(): boolean {
  return getBooleanFlag(ALERTS_ADDON_STORAGE_KEY, false);
}

export function setAlertsAddonEnabled(enabled: boolean): void {
  setBooleanFlag(ALERTS_ADDON_STORAGE_KEY, ALERTS_ADDON_EVENT, enabled);
}

export function getSchedulerAddonEnabled(): boolean {
  return getBooleanFlag(SCHEDULER_ADDON_STORAGE_KEY, false);
}

export function setSchedulerAddonEnabled(enabled: boolean): void {
  setBooleanFlag(SCHEDULER_ADDON_STORAGE_KEY, SCHEDULER_ADDON_EVENT, enabled);
}

export function getChatAddonEnabled(): boolean {
  return getBooleanFlag(CHAT_ADDON_STORAGE_KEY, false);
}

export function setChatAddonEnabled(enabled: boolean): void {
  setBooleanFlag(CHAT_ADDON_STORAGE_KEY, CHAT_ADDON_EVENT, enabled);
}

export {
  STRATEGY_ADDON_EVENT,
  STRATEGY_ADDON_STORAGE_KEY,
  ALERTS_ADDON_EVENT,
  ALERTS_ADDON_STORAGE_KEY,
  SCHEDULER_ADDON_EVENT,
  SCHEDULER_ADDON_STORAGE_KEY,
  CHAT_ADDON_EVENT,
  CHAT_ADDON_STORAGE_KEY,
};
