import { create } from 'zustand';

type TrackingBannerStatus = 'idle' | 'running' | 'success' | 'failed';

interface TrackingBannerState {
  status: TrackingBannerStatus;
  targetMac?: string;
  startedAt?: number;
  endsAt?: number;
  lastUpdated?: number;
  setCountdown: (mac: string, durationSec: number) => void;
  complete: () => void;
  fail: () => void;
  reset: () => void;
}

const EXPIRE_MS = 20_000;

export const useTrackingBannerStore = create<TrackingBannerState>((set, get) => ({
  status: 'idle',
  setCountdown: (mac, durationSec) => {
    const now = Date.now();
    const endsAt = now + durationSec * 1000;
    set({
      status: 'running',
      targetMac: mac.toUpperCase(),
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
            set({ status: 'idle', targetMac: undefined, startedAt: undefined, endsAt: undefined });
          }
        }, EXPIRE_MS);
      }
    }, durationSec * 1000);
  },
  complete: () => set({ status: 'success', lastUpdated: Date.now() }),
  fail: () => set({ status: 'failed', lastUpdated: Date.now() }),
  reset: () =>
    set({
      status: 'idle',
      targetMac: undefined,
      startedAt: undefined,
      endsAt: undefined,
      lastUpdated: undefined,
    }),
}));
