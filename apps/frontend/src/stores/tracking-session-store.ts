import { create } from 'zustand';

import { canonicalNodeId, useNodeStore } from './node-store';

interface TrackingSampleState {
  nodeId: string;
  lat: number;
  lon: number;
  distance: number;
  weight: number;
  timestamp: number;
}

export interface TrackingEstimate {
  lat: number;
  lon: number;
  confidence: number;
  updatedAt: number;
  label?: string | null;
  mac: string;
  targetId: string;
  contributors: TrackingContributor[];
}

interface TrackingContributor {
  nodeId?: string;
  lat: number;
  lon: number;
  weight?: number;
}

interface TrackingSessionEntry {
  targetId: string;
  mac: string;
  label?: string | null;
  duration: number;
  expiresAt: number;
  active: boolean;
  samples: Record<string, TrackingSampleState>;
  estimate?: TrackingEstimate;
}

interface TrackingStoreState {
  sessions: Record<string, TrackingSessionEntry>;
  macIndex: Record<string, string>;
  startSession: (args: {
    targetId: string;
    mac: string;
    label?: string | null;
    duration: number;
  }) => void;
  stopSession: (targetId: string) => void;
  recordSample: (sample: {
    mac: string;
    nodeId: string;
    rssi: number;
    band?: string;
    timestamp?: number;
  }) => void;
  applyServerEstimate: (estimate: {
    mac: string;
    lat: number;
    lon: number;
    confidence?: number;
    contributors?: Array<{ nodeId?: string; lat?: number; lon?: number; weight?: number }>;
  }) => void;
}

const MAX_SAMPLE_AGE_MS = 15_000;

export const useTrackingSessionStore = create<TrackingStoreState>((set, get) => ({
  sessions: {},
  macIndex: {},
  startSession: ({ targetId, mac, label, duration }) => {
    const macKey = mac.toUpperCase();
    set((state) => {
      const sessions = { ...state.sessions };
      const macIndex = { ...state.macIndex, [macKey]: targetId };
      sessions[targetId] = {
        targetId,
        mac: macKey,
        label,
        duration,
        expiresAt: Date.now() + duration * 1000,
        active: true,
        samples: {},
        estimate: undefined,
      };
      cleanupExpiredSessions(sessions, macIndex);
      return { sessions, macIndex };
    });
  },
  stopSession: (targetId) => {
    set((state) => {
      const sessions = { ...state.sessions };
      const session = sessions[targetId];
      if (!session) {
        return state;
      }
      delete sessions[targetId];
      const macIndex = { ...state.macIndex };
      Object.entries(macIndex).forEach(([mac, existingTargetId]) => {
        if (existingTargetId === targetId) {
          delete macIndex[mac];
        }
      });
      return { sessions, macIndex };
    });
  },
  recordSample: ({ mac, nodeId, rssi, band, timestamp }) => {
    const macKey = mac.toUpperCase();
    const targetId = get().macIndex[macKey];
    if (!targetId) {
      return;
    }
    const now = timestamp ?? Date.now();
    set((state) => {
      const sessions = { ...state.sessions };
      const session = sessions[targetId];
      if (!session || now > session.expiresAt) {
        delete sessions[targetId];
        const macIndex = { ...state.macIndex };
        Object.entries(macIndex).forEach(([key, value]) => {
          if (value === targetId) {
            delete macIndex[key];
          }
        });
        return { sessions, macIndex };
      }

      const canonicalId = canonicalNodeId(nodeId);
      const node = useNodeStore.getState().nodes[canonicalId];
      if (!node || !Number.isFinite(node.lat) || !Number.isFinite(node.lon)) {
        return state;
      }

      const distance = estimateDistance(rssi, band ?? 'wifi');
      const weight = distance > 0 ? 1 / (distance * distance) : 1;
      const samples = { ...session.samples };
      samples[canonicalId] = {
        nodeId: canonicalId,
        lat: node.lat as number,
        lon: node.lon as number,
        distance,
        weight,
        timestamp: now,
      };
      Object.entries(samples).forEach(([key, sample]) => {
        if (now - sample.timestamp > MAX_SAMPLE_AGE_MS) {
          delete samples[key];
        }
      });

      const estimate = computeEstimate(samples, {
        targetId: session.targetId,
        mac: session.mac,
        label: session.label,
      });

      sessions[targetId] = {
        ...session,
        samples,
        estimate,
      };

      cleanupExpiredSessions(sessions, state.macIndex);

      return { sessions, macIndex: state.macIndex };
    });
  },
  applyServerEstimate: ({ mac, lat, lon, confidence, contributors }) => {
    const now = Date.now();
    set((state) => {
      const macKey = mac.toUpperCase();
      const targetId = state.macIndex[macKey];
      if (!targetId) {
        return state;
      }
      const session = state.sessions[targetId];
      if (!session) {
        return state;
      }
      if (now > session.expiresAt) {
        const sessions = { ...state.sessions };
        delete sessions[targetId];
        const macIndex = { ...state.macIndex };
        Object.entries(macIndex).forEach(([key, value]) => {
          if (value === targetId) {
            delete macIndex[key];
          }
        });
        return { sessions, macIndex };
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return state;
      }
      const sanitizedContributors: TrackingContributor[] = [];
      (contributors ?? []).forEach((entry) => {
        if (
          typeof entry.lat === 'number' &&
          Number.isFinite(entry.lat) &&
          typeof entry.lon === 'number' &&
          Number.isFinite(entry.lon)
        ) {
          sanitizedContributors.push({
            nodeId: entry.nodeId,
            lat: entry.lat,
            lon: entry.lon,
            weight: typeof entry.weight === 'number' ? entry.weight : undefined,
          });
        }
      });
      const estimate: TrackingEstimate = {
        targetId: session.targetId,
        mac: session.mac,
        label: session.label,
        lat,
        lon,
        confidence:
          typeof confidence === 'number' ? confidence : (session.estimate?.confidence ?? 0),
        updatedAt: now,
        contributors: sanitizedContributors,
      };
      return {
        sessions: {
          ...state.sessions,
          [targetId]: {
            ...session,
            estimate,
          },
        },
        macIndex: state.macIndex,
      };
    });
  },
}));

function cleanupExpiredSessions(
  sessions: Record<string, TrackingSessionEntry>,
  macIndex: Record<string, string>,
): void {
  const now = Date.now();
  Object.entries(sessions).forEach(([targetId, session]) => {
    if (now > session.expiresAt) {
      delete sessions[targetId];
      Object.entries(macIndex).forEach(([mac, existingTargetId]) => {
        if (existingTargetId === targetId) {
          delete macIndex[mac];
        }
      });
    }
  });
}

function estimateDistance(rssi: number, band: string): number {
  const clamped = Math.max(-110, Math.min(-20, rssi));
  const txPower = band.toLowerCase().includes('ble') ? -59 : -45;
  const pathLoss = band.toLowerCase().includes('ble') ? 2.0 : 2.2;
  const distance = Math.pow(10, (txPower - clamped) / (10 * pathLoss));
  return Math.max(1, Math.min(distance, 250));
}

function computeEstimate(
  samples: Record<string, TrackingSampleState>,
  context: { targetId: string; mac: string; label?: string | null },
): TrackingEstimate | undefined {
  const entries = Object.values(samples);
  if (entries.length === 0) {
    return undefined;
  }
  let sumLat = 0;
  let sumLon = 0;
  let totalWeight = 0;
  let sumDistance = 0;
  entries.forEach((sample) => {
    sumLat += sample.lat * sample.weight;
    sumLon += sample.lon * sample.weight;
    totalWeight += sample.weight;
    sumDistance += sample.distance;
  });
  if (totalWeight === 0) {
    return undefined;
  }
  const averageDistance = sumDistance / entries.length;
  const coverageFactor = Math.min(1, entries.length / 3);
  const confidence = Math.min(1, coverageFactor * (1 / (1 + averageDistance / 80)));
  const contributors: TrackingContributor[] = [...entries]
    .sort((a, b) => b.weight - a.weight)
    .map((sample) => ({
      nodeId: sample.nodeId,
      lat: sample.lat,
      lon: sample.lon,
      weight: sample.weight,
    }));
  return {
    targetId: context.targetId,
    mac: context.mac,
    label: context.label,
    lat: sumLat / totalWeight,
    lon: sumLon / totalWeight,
    confidence,
    updatedAt: Date.now(),
    contributors,
  };
}
