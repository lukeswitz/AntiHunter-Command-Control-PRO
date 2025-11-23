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
  confidence?: number;
  uncertainty?: number;
  coordinatingNode?: string;
  lastUpdated?: number;
  setCountdown: (mac: string, durationSec: number) => void;
  setProcessing: () => void;
  complete: (params: {
    mac?: string;
    lat?: number;
    lon?: number;
    link?: string;
    confidence?: number;
    uncertainty?: number;
    coordinatingNode?: string;
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
      confidence: undefined,
      uncertainty: undefined,
      coordinatingNode: undefined,
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
  complete: ({ mac, lat, lon, link, confidence, uncertainty, coordinatingNode }) => {
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
      confidence,
      uncertainty,
      coordinatingNode,
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
      confidence: undefined,
      uncertainty: undefined,
      coordinatingNode: undefined,
      lastUpdated: undefined,
    }),
}));
