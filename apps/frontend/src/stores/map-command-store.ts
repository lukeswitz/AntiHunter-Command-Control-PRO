import { create } from 'zustand';

interface MapBounds {
  southWest: [number, number];
  northEast: [number, number];
}

interface MapTarget {
  lat: number;
  lon: number;
  zoom?: number;
  nodeId?: string;
  geofenceId?: string;
  bounds?: MapBounds;
  timestamp: number;
}

interface MapCommandState {
  target: MapTarget | null;
  preferredTarget: string | null;
  goto: (target: Omit<MapTarget, 'timestamp'>) => void;
  consume: () => void;
  setPreferredTarget: (target: string | null) => void;
  consumePreferredTarget: () => string | null;
}

export const useMapCommandStore = create<MapCommandState>((set, get) => ({
  target: null,
  preferredTarget: null,
  goto: ({ lat, lon, zoom, nodeId, geofenceId, bounds }) =>
    set({
      target: {
        lat,
        lon,
        zoom,
        nodeId,
        geofenceId,
        bounds,
        timestamp: Date.now(),
      },
    }),
  consume: () => set({ target: null }),
  setPreferredTarget: (target) => set({ preferredTarget: target }),
  consumePreferredTarget: () => {
    const current = get().preferredTarget;
    set({ preferredTarget: null });
    return current;
  },
}));
