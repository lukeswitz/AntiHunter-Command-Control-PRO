import { create } from 'zustand';

import type { AlarmLevel } from '../api/types';
import { canonicalNodeId } from './node-store';

const DEFAULT_ALERT_DURATION_MS = 10_000;
const SEVERITY_WEIGHT: Record<AlarmLevel, number> = {
  INFO: 0,
  NOTICE: 1,
  ALERT: 2,
  CRITICAL: 3,
};

export interface NodeAlert {
  nodeId: string;
  siteId?: string;
  category: string;
  level: AlarmLevel;
  message: string;
  lat?: number;
  lon?: number;
  triggeredAt: string;
  expiresAt: number;
}

interface TriggerAlertInput {
  nodeId: string;
  siteId?: string;
  category: string;
  level: AlarmLevel;
  message: string;
  lat?: number;
  lon?: number;
  timestamp?: string;
  durationMs?: number;
}

interface AlertStoreState {
  alerts: Record<string, NodeAlert>;
  triggerAlert: (input: TriggerAlertInput) => void;
  clearAlert: (nodeId: string) => void;
  purgeExpired: () => void;
}

const keyForAlert = (nodeId: string, siteId?: string) =>
  `${siteId ?? 'default'}::${canonicalNodeId(nodeId)}`;

export const useAlertStore = create<AlertStoreState>((set, get) => ({
  alerts: {},
  triggerAlert: (input) =>
    set((state) => {
      const now = Date.now();
      const duration = input.durationMs ?? DEFAULT_ALERT_DURATION_MS;
      const triggeredAt = input.timestamp ?? new Date().toISOString();
      const expiresAt = now + duration;
      const key = keyForAlert(input.nodeId, input.siteId);
      const existing = state.alerts[key];
      if (existing) {
        const existingWeight = SEVERITY_WEIGHT[existing.level];
        const incomingWeight = SEVERITY_WEIGHT[input.level];
        if (incomingWeight < existingWeight) {
          return {
            alerts: {
              ...state.alerts,
              [key]: {
                ...existing,
                expiresAt: Math.max(existing.expiresAt, expiresAt),
              },
            },
          };
        }
      }

      return {
        alerts: {
          ...state.alerts,
          [key]: {
            nodeId: canonicalNodeId(input.nodeId),
            siteId: input.siteId,
            category: input.category,
            level: input.level,
            message: input.message,
            lat: typeof input.lat === 'number' ? input.lat : undefined,
            lon: typeof input.lon === 'number' ? input.lon : undefined,
            triggeredAt,
            expiresAt,
          },
        },
      };
    }),
  clearAlert: (nodeId) =>
    set((state) => {
      const canonical = canonicalNodeId(nodeId);
      const nextAlerts: Record<string, NodeAlert> = {};
      Object.entries(state.alerts).forEach(([key, alert]) => {
        if (canonicalNodeId(alert.nodeId) !== canonical) {
          nextAlerts[key] = alert;
        }
      });
      return { alerts: nextAlerts };
    }),
  purgeExpired: () => {
    const now = Date.now();
    const current = get().alerts;
    const next: Record<string, NodeAlert> = {};
    Object.values(current).forEach((alert) => {
      if (alert.expiresAt > now) {
        const key = keyForAlert(alert.nodeId, alert.siteId);
        next[key] = alert;
      }
    });
    set({ alerts: next });
  },
}));

