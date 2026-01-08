import { create } from 'zustand';

type TriangulationStatus = 'idle' | 'running' | 'processing' | 'success' | 'failed';

interface TriangulationState {
  status: TriangulationStatus;
  targetMac?: string;
  startedAt?: number;
  endsAt?: number;
  link?: string;
  lat?: number;
  lon?: number;
  lastUpdated?: number;
  method?: 'tdoa' | 'rssi' | 'hybrid'; // Triangulation method used
  confidence?: number; // 0-1 confidence score
  contributors?: Array<{
    nodeId?: string;
    weight: number;
    maxRssi?: number;
    lat?: number;
    lon?: number;
  }>;
  setCountdown: (mac: string, durationSec: number) => void;
  setProcessing: () => void;
  complete: (params: {
    mac?: string;
    lat?: number;
    lon?: number;
    link?: string;
    method?: 'tdoa' | 'rssi' | 'hybrid';
    confidence?: number;
    contributors?: Array<{
      nodeId?: string;
      weight: number;
      maxRssi?: number;
      lat?: number;
      lon?: number;
    }>;
  }) => void;
  fail: () => void;
  reset: () => void;
}

const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // safety window while waiting for completion

export const useTriangulationStore = create<TriangulationState>((set, get) => ({
  status: 'idle',
  setCountdown: (mac, durationSec) => {
    const now = Date.now();
    set({
      status: 'running',
      targetMac: mac.toUpperCase(),
      startedAt: now,
      endsAt: now + durationSec * 1000,
      link: undefined,
      lat: undefined,
      lon: undefined,
      lastUpdated: now,
    });
    // auto-transition to processing when countdown elapses
    window.setTimeout(() => {
      if (get().status === 'running' && get().targetMac === mac.toUpperCase()) {
        set({ status: 'processing', lastUpdated: Date.now() });
        // safety timeout to avoid infinite processing state
        window.setTimeout(() => {
          if (get().status === 'processing' && get().targetMac === mac.toUpperCase()) {
            set({ status: 'failed', lastUpdated: Date.now() });
          }
        }, PROCESSING_TIMEOUT_MS);
      }
    }, durationSec * 1000);
  },
  setProcessing: () => {
    if (get().status === 'running') {
      set({ status: 'processing', lastUpdated: Date.now() });
    }
  },
  complete: ({ mac, lat, lon, link, method, confidence, contributors }) => {
    const stateMac = get().targetMac;
    const incomingMac = mac ? mac.toUpperCase() : undefined;
    if (stateMac && incomingMac && stateMac !== incomingMac) {
      return;
    }
    const success = Boolean(link) || (lat != null && lon != null);
    set({
      status: success ? 'success' : 'failed',
      targetMac: incomingMac ?? stateMac,
      link,
      lat,
      lon,
      method,
      confidence,
      contributors,
      lastUpdated: Date.now(),
    });
  },
  fail: () => set({ status: 'failed', lastUpdated: Date.now() }),
  reset: () =>
    set({
      status: 'idle',
      targetMac: undefined,
      startedAt: undefined,
      endsAt: undefined,
      link: undefined,
      lat: undefined,
      lon: undefined,
      method: undefined,
      confidence: undefined,
      contributors: undefined,
      lastUpdated: undefined,
    }),
}));
