import { create } from 'zustand';

type TrackingBannerStatus = 'idle' | 'running' | 'success' | 'failed';

interface TrackingBannerState {
  status: TrackingBannerStatus;
  targetMac?: string;
  pendingMac?: string;
  pendingDuration?: number;
  startedAt?: number;
  endsAt?: number;
  lastUpdated?: number;
  requestCountdown: (mac: string, durationSec: number) => void;
  setCountdown: (mac: string, durationSec: number) => void;
  complete: () => void;
  fail: () => void;
  reset: () => void;
}

const EXPIRE_MS = 20_000;

export const useTrackingBannerStore = create<TrackingBannerState>((set, get) => ({
  status: 'idle',
  requestCountdown: (mac, durationSec) => {
    set({
      pendingMac: mac.toUpperCase(),
      pendingDuration: durationSec,
    });
  },
  setCountdown: (mac, durationSec) => {
    const now = Date.now();
    const endsAt = now + durationSec * 1000;
    set({
      status: 'running',
      targetMac: mac.toUpperCase(),
      pendingMac: undefined,
      pendingDuration: undefined,
      startedAt: now,
      endsAt,
      lastUpdated: now,
    });
    window.setTimeout(() => {
      const state = get();
      if (state.status === 'running' && state.targetMac === mac.toUpperCase()) {
        set({ status: 'success', lastUpdated: Date.now() });
        window.setTimeout(() => {
          if (get().status === 'success' && get().targetMac === mac.toUpperCase()) {
            set({
              status: 'idle',
              targetMac: undefined,
              pendingMac: undefined,
              pendingDuration: undefined,
              startedAt: undefined,
              endsAt: undefined,
            });
          }
        }, EXPIRE_MS);
      }
    }, durationSec * 1000);
  },
  complete: () =>
    set({
      status: 'success',
      pendingMac: undefined,
      pendingDuration: undefined,
      lastUpdated: Date.now(),
    }),
  fail: () =>
    set({
      status: 'failed',
      pendingMac: undefined,
      pendingDuration: undefined,
      lastUpdated: Date.now(),
    }),
  reset: () =>
    set({
      status: 'idle',
      targetMac: undefined,
      pendingMac: undefined,
      pendingDuration: undefined,
      startedAt: undefined,
      endsAt: undefined,
      lastUpdated: undefined,
    }),
}));
