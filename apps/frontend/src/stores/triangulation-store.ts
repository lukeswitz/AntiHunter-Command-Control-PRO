import { create } from 'zustand';

type TriangulationStatus = 'idle' | 'running' | 'processing' | 'success' | 'failed';

interface DetectionEvent {
  nodeId: string;
  nodeLat: number;
  nodeLon: number;
  rssi?: number;
  hits?: number;
  timestamp: number;
  lat?: number; // Intermediate target position
  lon?: number; // Intermediate target position
}

interface TriangulationState {
  status: TriangulationStatus;
  targetMac?: string;
  startedAt?: number;
  endsAt?: number;
  link?: string;
  lat?: number; // Current/final target position
  lon?: number; // Current/final target position
  lastUpdated?: number;
  confidence?: number; // 0-1 confidence score from firmware
  detections: DetectionEvent[]; // Live detection events for visual effects
  contributors?: Array<{
    nodeId?: string;
    weight: number;
    maxRssi?: number;
    lat?: number;
    lon?: number;
  }>;
  setCountdown: (mac: string, durationSec: number) => void;
  setProcessing: () => void;
  addDetection: (detection: DetectionEvent) => void; // Add live detection for visuals
  complete: (params: {
    mac?: string;
    lat?: number;
    lon?: number;
    link?: string;
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
  detections: [],
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
      detections: [], // Clear previous detections
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
  addDetection: (detection) => {
    const current = get();
    if (current.status !== 'running' && current.status !== 'processing') {
      return; // Ignore detections when not triangulating
    }

    // Add detection with animation timestamp
    const newDetection = { ...detection, timestamp: Date.now() };

    // Keep last 10 detections for visuals (prevent memory leak on long sessions)
    const updatedDetections = [...current.detections, newDetection].slice(-10);

    // Update target position if provided (live movement)
    set({
      detections: updatedDetections,
      lat: detection.lat ?? current.lat,
      lon: detection.lon ?? current.lon,
      lastUpdated: Date.now(),
    });
  },
  complete: ({ mac, lat, lon, link, confidence, contributors }) => {
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
      confidence: undefined,
      contributors: undefined,
      detections: [],
      lastUpdated: undefined,
    }),
}));
