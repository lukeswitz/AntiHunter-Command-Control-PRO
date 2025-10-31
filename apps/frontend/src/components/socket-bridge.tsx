import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { AlarmLevel, Target } from '../api/types';
import { useAlarm } from '../providers/alarm-provider';
import { useSocket } from '../providers/socket-provider';
import { useAlertStore } from '../stores/alert-store';
import { useGeofenceStore } from '../stores/geofence-store';
import type { GeofenceEvent } from '../stores/geofence-store';
import { canonicalNodeId, NodeDiffPayload, NodeSummary, useNodeStore } from '../stores/node-store';
import { TerminalEntry, TerminalLevel, useTerminalStore } from '../stores/terminal-store';

const NOTIFICATION_CATEGORIES = new Set(['gps', 'status', 'console']);

type TerminalEntryInput = Omit<TerminalEntry, 'id' | 'timestamp'> & { timestamp?: string };

export function SocketBridge() {
  const socket = useSocket();
  const queryClient = useQueryClient();
  const { play } = useAlarm();
  const setInitialNodes = useNodeStore((state) => state.setInitialNodes);
  const applyDiff = useNodeStore((state) => state.applyDiff);
  const addEntry = useTerminalStore((state) => state.addEntry);
  const triggerAlert = useAlertStore((state) => state.triggerAlert);

  useEffect(() => {
    if (!socket) {
      return;
    }

    const handleInit = (payload: unknown) => {
      if (isInitPayload(payload)) {
        setInitialNodes(payload.nodes);
      }
    };

    const emitGeofenceEvents = (events: GeofenceEvent[], siteId?: string | null) => {
      events.forEach((event) => {
        const entry: TerminalEntryInput = {
          message: `Geofence ${event.geofenceName} (${event.transition.toUpperCase()}): ${event.message}`,
          level: alarmLevelToTerminal(event.level),
          source: 'geofence',
        };
        addEntry(entry);
        triggerAlert({
          nodeId: event.entityId,
          siteId: siteId ?? undefined,
          category: 'geofence',
          level: event.level,
          message: event.message,
          lat: event.lat,
          lon: event.lon,
          timestamp: new Date().toISOString(),
        });
        play(event.level);
      });
    };

    const handleNodeDiff = (payload: unknown) => {
      if (isNodeDiffPayload(payload)) {
        applyDiff(payload);

        if (payload.type === 'upsert') {
          const state = useNodeStore.getState();
          const node = state.nodes[canonicalNodeId(payload.node.id)];
          if (node) {
            const geofenceEvents = useGeofenceStore.getState().processNodePosition(node);
            emitGeofenceEvents(geofenceEvents, node.siteId ?? undefined);
          }
        }
      }
    };

    const handleEvent = (payload: unknown) => {
      const entry = parseEventPayload(payload);
      addEntry(entry);
      const alarmLevel = extractAlarmLevel(payload);
      if (alarmLevel) {
        const playbackLevel: AlarmLevel = alarmLevel === 'CRITICAL' ? 'ALERT' : alarmLevel;
        play(playbackLevel);
      }

      const targetDetails = extractTargetDetails(payload);
      if (targetDetails) {
        if (
          targetDetails.mac &&
          typeof targetDetails.lat === 'number' &&
          typeof targetDetails.lon === 'number' &&
          Number.isFinite(targetDetails.lat) &&
          Number.isFinite(targetDetails.lon)
        ) {
          const normalizedMac = normalizeMacKey(targetDetails.mac);
          queryClient.setQueryData(['targets'], (previous: Target[] | undefined) => {
            if (!previous) {
              return previous;
            }
            let changed = false;
            const next = previous.map((target) => {
              if (!target.mac) {
                return target;
              }
              const macKey = normalizeMacKey(target.mac);
              if (macKey !== normalizedMac) {
                return target;
              }
              const lat = targetDetails.lat ?? target.lat;
              const lon = targetDetails.lon ?? target.lon;
              const confidence =
                typeof targetDetails.confidence === 'number'
                  ? targetDetails.confidence
                  : (target.trackingConfidence ?? null);
              const updatedAt = targetDetails.detectedAt ?? target.updatedAt;
              if (
                Math.abs(target.lat - lat) > 1e-6 ||
                Math.abs(target.lon - lon) > 1e-6 ||
                (confidence ?? null) !== (target.trackingConfidence ?? null) ||
                updatedAt !== target.updatedAt
              ) {
                changed = true;
                return {
                  ...target,
                  lat,
                  lon,
                  updatedAt,
                  trackingConfidence: confidence,
                };
              }
              return target;
            });
            return changed ? next : previous;
          });
        }

        const nodeState = useNodeStore.getState();
        const node = targetDetails.nodeId
          ? nodeState.nodes[canonicalNodeId(targetDetails.nodeId)]
          : undefined;
        const lat = targetDetails.lat ?? node?.lat;
        const lon = targetDetails.lon ?? node?.lon;
        if (
          typeof lat === 'number' &&
          Number.isFinite(lat) &&
          typeof lon === 'number' &&
          Number.isFinite(lon)
        ) {
          const entityId =
            targetDetails.mac ??
            targetDetails.nodeId ??
            `target-${targetDetails.detectedAt ?? Date.now()}`;
          const entityType = targetDetails.deviceType ?? 'target';
          const entityLabel =
            [targetDetails.deviceType, targetDetails.mac ?? targetDetails.nodeId]
              .filter(Boolean)
              .join(' ')
              .trim() || entityId;
          const geofenceEvents = useGeofenceStore.getState().processCoordinateEvent({
            entityId,
            entityLabel,
            entityType,
            lat,
            lon,
          });
          emitGeofenceEvents(geofenceEvents, node?.siteId ?? undefined);
        }
      }

      const alertDetails = extractAlertDetails(payload);
      if (alertDetails && alertDetails.nodeId) {
        const level = (alertDetails.level ?? 'NOTICE').toUpperCase() as AlarmLevel;
        triggerAlert({
          nodeId: alertDetails.nodeId,
          siteId: alertDetails.siteId,
          category: alertDetails.category ?? 'status',
          level,
          message: alertDetails.message ?? 'Alert triggered',
          lat: alertDetails.lat,
          lon: alertDetails.lon,
          timestamp: alertDetails.timestamp,
        });
      }
    };

    const handleCommandUpdate = (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const command = payload as { id?: string; name?: string; status?: string };
      const status = String(command.status ?? 'UNKNOWN').toUpperCase();
      const level: TerminalLevel =
        status === 'ERROR' ? 'critical' : status === 'OK' ? 'notice' : 'info';
      const name = command.name ?? command.id ?? 'command';

      const entry: TerminalEntryInput = {
        message: `Command ${name} -> ${status}`,
        level,
        source: 'command',
      };

      addEntry(entry);
      if (status === 'ERROR') {
        play('ALERT');
      }
    };

    socket.on('init', handleInit);
    socket.on('nodes', handleNodeDiff);
    socket.on('event', handleEvent);
    socket.on('command.update', handleCommandUpdate);

    return () => {
      socket.off('init', handleInit);
      socket.off('nodes', handleNodeDiff);
      socket.off('event', handleEvent);
      socket.off('command.update', handleCommandUpdate);
    };
  }, [socket, setInitialNodes, applyDiff, addEntry, play, triggerAlert, queryClient]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const timer = window.setInterval(() => {
      useAlertStore.getState().purgeExpired();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return null;
}

interface InitPayload {
  nodes: NodeSummary[];
}

function isInitPayload(payload: unknown): payload is InitPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'nodes' in payload &&
    Array.isArray((payload as { nodes: unknown[] }).nodes)
  );
}

function isNodeDiffPayload(payload: unknown): payload is NodeDiffPayload {
  return typeof payload === 'object' && payload !== null && 'type' in payload && 'node' in payload;
}

function parseEventPayload(payload: unknown): TerminalEntryInput {
  if (typeof payload === 'string') {
    return { message: payload, level: 'info', source: 'ws' };
  }

  if (payload && typeof payload === 'object') {
    const base = payload as {
      type?: string;
      message?: string;
      line?: string;
      level?: string;
      raw?: string;
      nodeId?: string;
      timestamp?: string;
      siteId?: string;
      category?: string;
    };

    if (base.type === 'event.alert') {
      const levelRaw = typeof base.level === 'string' ? base.level.toUpperCase() : undefined;
      const category = typeof base.category === 'string' ? base.category.toLowerCase() : undefined;

      const message = base.message ?? `Alert from ${base.nodeId ?? 'unknown node'}`;
      const messageUpper = message.toUpperCase();

      let terminalLevel = alarmLevelToTerminal(levelRaw as AlarmLevel | undefined);
      let isNotification =
        !levelRaw ||
        levelRaw === 'INFO' ||
        levelRaw === 'NOTICE' ||
        (category ? NOTIFICATION_CATEGORIES.has(category) : false);

      const isVibration = category === 'vibration' || messageUpper.includes('VIBRATION');
      if (isVibration) {
        terminalLevel = 'alert';
        isNotification = false;
      } else if (isNotification && terminalLevel === 'info') {
        terminalLevel = 'notice';
      }

      const source = isNotification ? 'notification' : 'alert';
      return {
        message,
        level: terminalLevel,
        source,
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'raw') {
      const rawValue = (base as { raw?: unknown }).raw;
      const message =
        typeof rawValue === 'string'
          ? rawValue
          : rawValue != null
            ? JSON.stringify(rawValue)
            : JSON.stringify(payload);
      return {
        message,
        level: 'info',
        source: 'raw',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'event.target') {
      return {
        message: base.message ?? `Device discovered by ${base.nodeId ?? 'unknown node'}`,
        level: 'notice',
        source: 'inventory',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'command.ack') {
      return {
        message: base.message ?? `Command acknowledgement from ${base.nodeId ?? 'node'}`,
        level: 'info',
        source: 'command',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type === 'command.result') {
      return {
        message: base.message ?? `Command result from ${base.nodeId ?? 'node'}`,
        level: 'notice',
        source: 'command',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if (base.type && (base.type.startsWith('node.') || base.type === 'nodes.diff')) {
      return {
        message: JSON.stringify(payload),
        level: 'info',
        source: 'raw',
        timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
        siteId: base.siteId,
      };
    }

    if ('line' in base) {
      const { line, type } = base as { line: string; type?: string };
      const level: TerminalLevel =
        type === 'critical' ? 'critical' : type === 'alert' ? 'alert' : 'info';
      return { message: line, level, source: type ?? 'raw' };
    }

    return {
      message: JSON.stringify(payload),
      level: 'info',
      source: 'ws',
    };
  }

  return {
    message: String(payload),
    level: 'info',
    source: 'ws',
  };
}

function extractAlarmLevel(payload: unknown): AlarmLevel | null {
  if (payload && typeof payload === 'object' && 'type' in payload) {
    const base = payload as { type?: string; level?: string };
    if (base.type === 'event.alert' && base.level) {
      return base.level.toUpperCase() as AlarmLevel;
    }
    if (base.type === 'event.target') {
      return 'NOTICE';
    }
  }
  return null;
}

interface TargetEventDetails {
  mac?: string;
  nodeId?: string;
  rssi?: number;
  deviceType?: string;
  lat?: number;
  lon?: number;
  detectedAt?: string;
  confidence?: number;
}

function extractTargetDetails(payload: unknown): TargetEventDetails | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const base = payload as {
    type?: string;
    mac?: string;
    nodeId?: string;
    rssi?: number | string;
    deviceType?: string;
    lat?: number | string;
    lon?: number | string;
    timestamp?: string;
    ts?: string;
    confidence?: number;
    tracking?: { confidence?: number };
  };

  if (base.type !== 'event.target') {
    return null;
  }

  const trackingConfidence =
    typeof base.confidence === 'number'
      ? base.confidence
      : typeof base.tracking?.confidence === 'number'
        ? base.tracking.confidence
        : undefined;

  return {
    mac: base.mac,
    nodeId: base.nodeId,
    rssi: toNumber(base.rssi),
    deviceType: base.deviceType,
    lat: toNumber(base.lat),
    lon: toNumber(base.lon),
    detectedAt:
      typeof base.timestamp === 'string'
        ? base.timestamp
        : typeof base.ts === 'string'
          ? base.ts
          : undefined,
    confidence: typeof trackingConfidence === 'number' ? trackingConfidence : undefined,
  };
}

interface AlertDetails {
  nodeId?: string;
  siteId?: string;
  category?: string;
  level?: AlarmLevel;
  message?: string;
  lat?: number;
  lon?: number;
  timestamp?: string;
}

function extractAlertDetails(payload: unknown): AlertDetails | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const base = payload as {
    type?: string;
    category?: string;
    nodeId?: string;
    level?: string;
    message?: string;
    lat?: number | string;
    lon?: number | string;
    timestamp?: string;
    data?: Record<string, unknown>;
    siteId?: string;
  };

  if (base.type !== 'event.alert') {
    return null;
  }

  const data = base.data ?? {};

  return {
    nodeId: base.nodeId,
    siteId: base.siteId,
    category: base.category,
    level: base.level ? (base.level.toUpperCase() as AlarmLevel) : undefined,
    message: base.message,
    lat: toNumber(base.lat ?? (data as Record<string, unknown>).lat),
    lon: toNumber(base.lon ?? (data as Record<string, unknown>).lon),
    timestamp: typeof base.timestamp === 'string' ? base.timestamp : undefined,
  };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeMacKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function alarmLevelToTerminal(level: AlarmLevel | undefined): TerminalLevel {
  switch (level) {
    case 'CRITICAL':
      return 'critical';
    case 'ALERT':
      return 'alert';
    case 'NOTICE':
      return 'notice';
    case 'INFO':
    default:
      return 'info';
  }
}
