import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { NodeSummary } from './node-store';
import type { AlarmLevel } from '../api/types';

export interface GeofenceVertex {
  lat: number;
  lon: number;
}

export interface GeofenceAlarmConfig {
  enabled: boolean;
  level: AlarmLevel;
  message: string;
  triggerOnExit?: boolean;
}

export interface Geofence {
  id: string;
  name: string;
  description?: string | null;
  color: string;
  createdAt: string;
  updatedAt: string;
  polygon: GeofenceVertex[];
  alarm: GeofenceAlarmConfig;
}

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

type GeofenceUpdate = Partial<Omit<Geofence, 'id' | 'alarm' | 'polygon'>> & {
  polygon?: GeofenceVertex[];
  alarm?: Partial<GeofenceAlarmConfig>;
};

interface GeofenceStoreState {
  geofences: Geofence[];
  states: GeofenceStateMap;
  highlighted: Record<string, number>;
  addGeofence: (geofence: {
    id?: string;
    name: string;
    description?: string | null;
    color?: string;
    polygon: GeofenceVertex[];
    alarm: GeofenceAlarmConfig;
  }) => Geofence;
  updateGeofence: (id: string, update: GeofenceUpdate) => void;
  deleteGeofence: (id: string) => void;
  setAlarmEnabled: (id: string, enabled: boolean) => void;
  processNodePosition: (node: NodeSummary) => GeofenceEvent[];
  processCoordinateEvent: (input: {
    entityId: string;
    entityLabel: string;
    entityType?: string;
    lat: number;
    lon: number;
  }) => GeofenceEvent[];
  resetStates: (geofenceId: string) => void;
  setHighlighted: (id: string, durationMs: number) => void;
  pruneHighlights: (now?: number) => void;
}

const randomColor = () => {
  const palette = ['#1d4ed8', '#9333ea', '#f97316', '#22c55e', '#14b8a6', '#f973a0', '#facc15'];
  return palette[Math.floor(Math.random() * palette.length)];
};

const generateId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `gfn-${crypto.randomUUID()}`;
  }
  return `gfn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

const initialState: Pick<GeofenceStoreState, 'geofences' | 'states' | 'highlighted'> = {
  geofences: [],
  states: {},
  highlighted: {},
};

export const useGeofenceStore = create<GeofenceStoreState>()(
  persist(
    (set, get) => ({
      ...initialState,
      addGeofence: (incoming) => {
        const geofence: Geofence = {
          id: incoming.id ?? generateId(),
          name: incoming.name,
          description: incoming.description ?? null,
          color: incoming.color ?? randomColor(),
          polygon: incoming.polygon,
          alarm: incoming.alarm,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        set((state) => ({
          geofences: [...state.geofences, geofence],
        }));
        return geofence;
      },
      updateGeofence: (id, update) =>
        set((state) => {
          const geofences = state.geofences.map((geofence) =>
            geofence.id === id
              ? {
                  ...geofence,
                  ...update,
                  polygon: update.polygon ?? geofence.polygon,
                  alarm: update.alarm ? { ...geofence.alarm, ...update.alarm } : geofence.alarm,
                  updatedAt: new Date().toISOString(),
                }
              : geofence,
          );
          return { geofences };
        }),
      deleteGeofence: (id) =>
        set((state) => {
          const geofences = state.geofences.filter((geofence) => geofence.id !== id);
          const nextStates = { ...state.states };
          delete nextStates[id];
          const nextHighlighted = { ...state.highlighted };
          delete nextHighlighted[id];
          return { geofences, states: nextStates, highlighted: nextHighlighted };
        }),
      setAlarmEnabled: (id, enabled) =>
        set((state) => ({
          geofences: state.geofences.map((geofence) =>
            geofence.id === id
              ? {
                  ...geofence,
                  alarm: {
                    ...geofence.alarm,
                    enabled,
                  },
                  updatedAt: new Date().toISOString(),
                }
              : geofence,
          ),
        })),
      processNodePosition: (node) => {
        const { geofences, states } = get();
        if (!node || typeof node.lat !== 'number' || typeof node.lon !== 'number') {
          return [];
        }
        const nodeId = node.id;
        const lat = node.lat;
        const lon = node.lon;
        const nextStates: GeofenceStateMap = { ...states };
        const events: GeofenceEvent[] = [];

        geofences.forEach((geofence) => {
          if (geofence.polygon.length < 3 || !geofence.alarm.enabled) {
            return;
          }

          const inside = pointInPolygon(lat, lon, geofence.polygon);
          const previous = states[geofence.id]?.[nodeId] ?? false;

          if (!nextStates[geofence.id]) {
            nextStates[geofence.id] = {};
          }
          nextStates[geofence.id][nodeId] = inside;

          if (inside && !previous) {
            events.push({
              geofenceId: geofence.id,
              geofenceName: geofence.name,
              entityId: nodeId,
              entityLabel: node.name ?? nodeId,
              entityType: 'node',
              lat,
              lon,
              level: geofence.alarm.level,
              message: geofence.alarm.message?.trim().length
                ? formatMessage(geofence.alarm.message, {
                    geofence: geofence.name,
                    entity: node.name ?? nodeId,
                    node: node.name ?? nodeId,
                    type: 'node',
                    event: 'enter',
                  })
                : `${node.name ?? nodeId} entered geofence ${geofence.name}`,
              transition: 'enter',
            });
          } else if (!inside && previous && geofence.alarm.triggerOnExit) {
            events.push({
              geofenceId: geofence.id,
              geofenceName: geofence.name,
              entityId: nodeId,
              entityLabel: node.name ?? nodeId,
              entityType: 'node',
              lat,
              lon,
              level: geofence.alarm.level,
              message: geofence.alarm.message?.trim().length
                ? formatMessage(geofence.alarm.message, {
                    geofence: geofence.name,
                    entity: node.name ?? nodeId,
                    node: node.name ?? nodeId,
                    type: 'node',
                    event: 'exit',
                  })
                : `${node.name ?? nodeId} exited geofence ${geofence.name}`,
              transition: 'exit',
            });
          }
        });

        set({ states: nextStates });
        return events;
      },
      processCoordinateEvent: ({ entityId, entityLabel, entityType, lat, lon }) => {
        const { geofences, states } = get();
        const key = entityId;
        const typeLabel = entityType ?? 'entity';
        const nextStates: GeofenceStateMap = { ...states };
        const events: GeofenceEvent[] = [];

        geofences.forEach((geofence) => {
          if (geofence.polygon.length < 3 || !geofence.alarm.enabled) {
            return;
          }
          const inside = pointInPolygon(lat, lon, geofence.polygon);
          const previous = states[geofence.id]?.[key] ?? false;
          if (!nextStates[geofence.id]) {
            nextStates[geofence.id] = {};
          }
          nextStates[geofence.id][key] = inside;

          if (inside && !previous) {
            events.push({
              geofenceId: geofence.id,
              geofenceName: geofence.name,
              entityId: key,
              entityLabel,
              entityType: typeLabel,
              lat,
              lon,
              level: geofence.alarm.level,
              message: formatMessage(geofence.alarm.message, {
                geofence: geofence.name,
                entity: entityLabel,
                node: entityLabel,
                type: typeLabel,
                event: 'enter',
              }),
              transition: 'enter',
            });
          } else if (!inside && previous && geofence.alarm.triggerOnExit) {
            events.push({
              geofenceId: geofence.id,
              geofenceName: geofence.name,
              entityId: key,
              entityLabel,
              entityType: typeLabel,
              lat,
              lon,
              level: geofence.alarm.level,
              message: formatMessage(geofence.alarm.message, {
                geofence: geofence.name,
                entity: entityLabel,
                node: entityLabel,
                type: typeLabel,
                event: 'exit',
              }),
              transition: 'exit',
            });
          }
        });

        set({ states: nextStates });
        return events;
      },
      resetStates: (geofenceId) =>
        set((state) => {
          const next = { ...state.states };
          const highlighted = { ...state.highlighted };
          if (geofenceId) {
            delete next[geofenceId];
            delete highlighted[geofenceId];
            return { states: next, highlighted };
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
          const entries = Object.entries(state.highlighted).filter(([, expires]) => expires > now);
          if (entries.length === Object.keys(state.highlighted).length) {
            return state;
          }
          const next: Record<string, number> = {};
          entries.forEach(([key, value]) => {
            next[key] = value;
          });
          return { highlighted: next };
        }),
    }),
    {
      name: 'command-center.geofences',
      partialize: (state) => ({
        geofences: state.geofences,
      }),
    },
  ),
);

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
