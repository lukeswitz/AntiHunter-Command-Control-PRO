import { create } from 'zustand';

import type { NodeSummary } from './node-store';
import { apiClient } from '../api/client';
import type {
  AlarmLevel,
  CreateGeofenceRequest,
  Geofence,
  GeofenceAlarmConfig,
  GeofenceVertex,
  UpdateGeofenceRequest,
} from '../api/types';

export interface GeofenceEvent {
  geofenceId: string;
  geofenceName: string;
  entityId: string;
  entityLabel: string;
  entityType: string;
  lat: number;
  lon: number;
  level: AlarmLevel;
  message: string;
  transition: 'enter' | 'exit';
}

type GeofenceStateMap = Record<string, Record<string, boolean>>;

export type GeofenceUpdate = Partial<Omit<Geofence, 'alarm' | 'polygon' | 'site'>> & {
  polygon?: GeofenceVertex[];
  alarm?: Partial<GeofenceAlarmConfig>;
};

interface GeofenceStoreState {
  geofences: Geofence[];
  states: GeofenceStateMap;
  highlighted: Record<string, number>;
  setGeofences: (geofences: Geofence[]) => void;
  upsertGeofence: (geofence: Geofence) => void;
  removeGeofence: (id: string) => void;
  loadGeofences: () => Promise<void>;
  addGeofence: (input: CreateGeofenceRequest) => Promise<Geofence>;
  updateGeofence: (id: string, update: GeofenceUpdate) => void;
  deleteGeofence: (id: string) => Promise<void>;
  setAlarmEnabled: (id: string, enabled: boolean) => void;
  processNodePosition: (node: NodeSummary) => GeofenceEvent[];
  processCoordinateEvent: (input: {
    entityId: string;
    entityLabel: string;
    entityType?: string;
    lat: number;
    lon: number;
  }) => GeofenceEvent[];
  resetStates: (geofenceId?: string) => void;
  setHighlighted: (id: string, durationMs: number) => void;
  pruneHighlights: (now?: number) => void;
}

const PATCH_DEBOUNCE_MS = 400;
const PROCESS_NODE_POSITIONS = false;
const pendingPatches = new Map<string, UpdateGeofenceRequest>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

const randomColor = () => {
  const palette = ['#1d4ed8', '#9333ea', '#f97316', '#22c55e', '#14b8a6', '#f973a0', '#facc15'];
  return palette[Math.floor(Math.random() * palette.length)];
};

export const useGeofenceStore = create<GeofenceStoreState>()((set, get) => {
  const queuePatch = (id: string, update: GeofenceUpdate) => {
    const patch = mergePatch(pendingPatches.get(id), update);
    if (!patch || Object.keys(patch).length === 0) {
      return;
    }
    pendingPatches.set(id, patch);

    const existingTimer = pendingTimers.get(id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const schedule = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
    const timer = schedule(async () => {
      pendingTimers.delete(id);
      const payload = pendingPatches.get(id);
      if (!payload || Object.keys(payload).length === 0) {
        pendingPatches.delete(id);
        return;
      }
      pendingPatches.delete(id);
      try {
        const updated = await apiClient.patch<Geofence>(`/geofences/${id}`, payload);
        set((state) => ({
          geofences: state.geofences.map((geofence) =>
            geofence.id === updated.id ? updated : geofence,
          ),
        }));
      } catch (error) {
        console.error('Failed to update geofence', error);
      }
    }, PATCH_DEBOUNCE_MS);

    pendingTimers.set(id, timer);
  };

  const clearPending = (id: string) => {
    pendingPatches.delete(id);
    const timer = pendingTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(id);
    }
  };

  return {
    geofences: [],
    states: {},
    highlighted: {},
    setGeofences: (geofences) =>
      set((state) => {
        const nextStates = { ...state.states };
        Object.keys(nextStates).forEach((id) => {
          if (!geofences.some((geofence) => geofence.id === id)) {
            delete nextStates[id];
          }
        });
        return { geofences, states: nextStates };
      }),
    upsertGeofence: (geofence) =>
      set((state) => {
        const exists = state.geofences.some((item) => item.id === geofence.id);
        const geofences = exists
          ? state.geofences.map((item) => (item.id === geofence.id ? geofence : item))
          : [...state.geofences, geofence];
        return { geofences };
      }),
    removeGeofence: (id) =>
      set((state) => {
        clearPending(id);
        const { [id]: _removed, ...restStates } = state.states;
        const { [id]: _highlight, ...restHighlights } = state.highlighted;
        return {
          geofences: state.geofences.filter((geofence) => geofence.id !== id),
          states: restStates,
          highlighted: restHighlights,
        };
      }),
    loadGeofences: async () => {
      try {
        const geofences = await apiClient.get<Geofence[]>('/geofences');
        get().setGeofences(geofences);
      } catch (error) {
        console.error('Failed to load geofences', error);
      }
    },
    addGeofence: async (input) => {
      const payload: CreateGeofenceRequest = {
        name: input.name,
        description: input.description ?? null,
        color: input.color ?? randomColor(),
        siteId: input.siteId ?? undefined,
        polygon: input.polygon.map(normalizeVertex),
        alarm: {
          enabled: input.alarm.enabled,
          level: input.alarm.level,
          message: input.alarm.message,
          triggerOnExit: input.alarm.triggerOnExit ?? false,
        },
      };

      const geofence = await apiClient.post<Geofence>('/geofences', payload);
      set((state) => ({
        geofences: [...state.geofences, geofence],
      }));
      return geofence;
    },
    updateGeofence: (id, update) => {
      set((state) => {
        const nextGeofences = state.geofences.map((geofence) => {
          if (geofence.id !== id) {
            return geofence;
          }
          const updated: Geofence = {
            ...geofence,
            ...('siteId' in update ? { siteId: update.siteId ?? null } : null),
            ...('name' in update ? { name: update.name ?? geofence.name } : null),
            ...('description' in update ? { description: update.description ?? null } : null),
            ...('color' in update ? { color: update.color ?? geofence.color } : null),
            ...('originSiteId' in update
              ? { originSiteId: update.originSiteId ?? geofence.originSiteId ?? null }
              : null),
            polygon: update.polygon ? update.polygon.map(normalizeVertex) : geofence.polygon,
            alarm: update.alarm ? { ...geofence.alarm, ...update.alarm } : geofence.alarm,
            updatedAt: new Date().toISOString(),
          };
          return updated;
        });
        return { geofences: nextGeofences };
      });

      queuePatch(id, update);
    },
    deleteGeofence: async (id) => {
      try {
        await apiClient.delete(`/geofences/${id}`);
        get().removeGeofence(id);
      } catch (error) {
        console.error('Failed to delete geofence', error);
      }
    },
    setAlarmEnabled: (id, enabled) => {
      get().updateGeofence(id, { alarm: { enabled } });
    },
    processNodePosition: (node) => {
      if (!PROCESS_NODE_POSITIONS) {
        return [];
      }
      const events: GeofenceEvent[] = [];
      const { geofences } = get();

      geofences.forEach((geofence) => {
        if (geofence.polygon.length < 3 || !geofence.alarm.enabled) {
          return;
        }

        const inside = pointInPolygon(node.lat, node.lon, geofence.polygon);
        const key = canonicalEntityKey(node.id, node.siteId ?? undefined);

        const currentStates = get().states;
        const prevState = currentStates[geofence.id]?.[key] ?? false;

        const nextStates = { ...currentStates };
        const geofenceStates = { ...(nextStates[geofence.id] ?? {}) };
        geofenceStates[key] = inside;
        nextStates[geofence.id] = geofenceStates;
        set({ states: nextStates });

        if (inside && !prevState) {
          events.push({
            geofenceId: geofence.id,
            geofenceName: geofence.name,
            entityId: key,
            entityLabel: node.name ?? node.id,
            entityType: 'node',
            lat: node.lat,
            lon: node.lon,
            level: geofence.alarm.level,
            message: formatMessage(geofence.alarm.message, {
              geofence: geofence.name,
              entity: node.name ?? node.id,
              node: node.name ?? node.id,
              type: 'node',
              event: 'enter',
            }),
            transition: 'enter',
          });
        } else if (!inside && prevState && geofence.alarm.triggerOnExit) {
          events.push({
            geofenceId: geofence.id,
            geofenceName: geofence.name,
            entityId: key,
            entityLabel: node.name ?? node.id,
            entityType: 'node',
            lat: node.lat,
            lon: node.lon,
            level: geofence.alarm.level,
            message: formatMessage(geofence.alarm.message, {
              geofence: geofence.name,
              entity: node.name ?? node.id,
              node: node.name ?? node.id,
              type: 'node',
              event: 'exit',
            }),
            transition: 'exit',
          });
        }
      });

      return events;
    },
    processCoordinateEvent: ({ entityId, entityLabel, entityType, lat, lon }) => {
      const events: GeofenceEvent[] = [];
      const { geofences } = get();

      geofences.forEach((geofence) => {
        if (geofence.polygon.length < 3 || !geofence.alarm.enabled) {
          return;
        }

        const inside = pointInPolygon(lat, lon, geofence.polygon);
        const key = canonicalEntityKey(entityId, geofence.siteId ?? undefined);

        const currentStates = get().states;
        const prevState = currentStates[geofence.id]?.[key] ?? false;

        const nextStates = { ...currentStates };
        const geofenceStates = { ...(nextStates[geofence.id] ?? {}) };
        geofenceStates[key] = inside;
        nextStates[geofence.id] = geofenceStates;
        set({ states: nextStates });

        if (inside && !prevState) {
          events.push({
            geofenceId: geofence.id,
            geofenceName: geofence.name,
            entityId: key,
            entityLabel,
            entityType: entityType ?? 'entity',
            lat,
            lon,
            level: geofence.alarm.level,
            message: formatMessage(geofence.alarm.message, {
              geofence: geofence.name,
              entity: entityLabel,
              node: entityLabel,
              type: entityType ?? 'entity',
              event: 'enter',
            }),
            transition: 'enter',
          });
        } else if (!inside && prevState && geofence.alarm.triggerOnExit) {
          events.push({
            geofenceId: geofence.id,
            geofenceName: geofence.name,
            entityId: key,
            entityLabel,
            entityType: entityType ?? 'entity',
            lat,
            lon,
            level: geofence.alarm.level,
            message: formatMessage(geofence.alarm.message, {
              geofence: geofence.name,
              entity: entityLabel,
              node: entityLabel,
              type: entityType ?? 'entity',
              event: 'exit',
            }),
            transition: 'exit',
          });
        }
      });

      return events;
    },
    resetStates: (geofenceId) =>
      set((state) => {
        if (geofenceId) {
          const nextStates = { ...state.states };
          delete nextStates[geofenceId];
          const nextHighlights = { ...state.highlighted };
          delete nextHighlights[geofenceId];
          return { states: nextStates, highlighted: nextHighlights };
        }
        return { states: {}, highlighted: {} };
      }),
    setHighlighted: (id, durationMs) =>
      set((state) => {
        if (!id) {
          return state;
        }
        const next = { ...state.highlighted };
        if (durationMs <= 0) {
          delete next[id];
        } else {
          next[id] = Date.now() + durationMs;
        }
        return { highlighted: next };
      }),
    pruneHighlights: (now = Date.now()) =>
      set((state) => {
        const remaining = Object.entries(state.highlighted).filter(([, expires]) => expires > now);
        if (remaining.length === Object.keys(state.highlighted).length) {
          return state;
        }
        const next: Record<string, number> = {};
        remaining.forEach(([id, expires]) => {
          next[id] = expires;
        });
        return { highlighted: next };
      }),
  };
});

function mergePatch(
  existing: UpdateGeofenceRequest | undefined,
  update: GeofenceUpdate,
): UpdateGeofenceRequest | undefined {
  const patch: UpdateGeofenceRequest = existing ? { ...existing } : {};

  if (update.name !== undefined) {
    patch.name = update.name;
  }
  if (update.description !== undefined) {
    patch.description = update.description ?? null;
  }
  if (update.color !== undefined) {
    patch.color = update.color ?? undefined;
  }
  if (update.siteId !== undefined) {
    patch.siteId = update.siteId ?? null;
  }
  if (update.polygon) {
    patch.polygon = update.polygon.map(normalizeVertex);
  }
  if (update.alarm) {
    patch.alarm = { ...(patch.alarm ?? {}), ...update.alarm };
  }

  return patch;
}

function normalizeVertex(vertex: GeofenceVertex): GeofenceVertex {
  const lat = Number(vertex.lat);
  const lon = Number(vertex.lon);
  return {
    lat: Number.isFinite(lat) ? lat : 0,
    lon: Number.isFinite(lon) ? lon : 0,
  };
}

function canonicalEntityKey(entityId: string, siteId?: string): string {
  return `${siteId ?? 'default'}::${entityId}`;
}

function pointInPolygon(lat: number, lon: number, polygon: GeofenceVertex[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lat;
    const yi = polygon[i].lon;
    const xj = polygon[j].lat;
    const yj = polygon[j].lon;

    const intersect =
      yi > lon !== yj > lon && lat < ((xj - xi) * (lon - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function formatMessage(
  template: string | undefined,
  context: {
    geofence: string;
    entity: string;
    node: string;
    type: string;
    event: 'enter' | 'exit';
  },
): string {
  const message =
    template && template.trim().length > 0
      ? template
      : `{entity} ${context.event}s geofence {geofence}`;
  return message
    .replace(/\{geofence\}/gi, context.geofence)
    .replace(/\{entity\}/gi, context.entity)
    .replace(/\{node\}/gi, context.node)
    .replace(/\{type\}/gi, context.type)
    .replace(/\{event\}/gi, context.event);
}
