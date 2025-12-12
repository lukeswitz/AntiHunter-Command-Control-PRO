import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface TargetHistoryPoint {
  lat: number;
  lon: number;
  ts: string;
}

export interface TargetMarker {
  id: string;
  mac?: string | null;
  name?: string | null;
  nodeId?: string | null;
  firstNodeId?: string | null;
  lat: number;
  lon: number;
  lastSeen: string;
  deviceType?: string | null;
  comment?: string;
  tracking?: boolean;
  trackingSince?: string | null;
  trackingConfidence?: number;
  trackingUncertainty?: number;
  triangulationMethod?: string;
  triangulatedRecent?: boolean;
  history?: TargetHistoryPoint[];
}

interface TrackingEntry {
  active: boolean;
  since: string | null;
}

interface TargetStoreState {
  commentMap: Record<string, string>;
  trackingMap: Record<string, TrackingEntry>;
  setComment: (targetId: string, comment: string) => void;
  setTracking: (targetId: string, tracking: boolean) => void;
  reset: () => void;
}

export const useTargetStore = create<TargetStoreState>()(
  persist(
    (set, _get) => ({
      commentMap: {},
      trackingMap: {},
      setComment: (targetId, comment) =>
        set((state) => ({
          commentMap: {
            ...state.commentMap,
            [targetId]: comment,
          },
        })),
      setTracking: (targetId, tracking) =>
        set((state) => ({
          trackingMap: {
            ...state.trackingMap,
            [targetId]: {
              active: tracking,
              since: tracking ? new Date().toISOString() : null,
            },
          },
        })),
      reset: () => set({ commentMap: {}, trackingMap: {} }),
    }),
    {
      name: 'command-center.target-ui',
      partialize: (state) => ({
        commentMap: state.commentMap,
        trackingMap: state.trackingMap,
      }),
    },
  ),
);
