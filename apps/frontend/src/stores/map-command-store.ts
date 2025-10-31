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
  goto: (target: Omit<MapTarget, 'timestamp'>) => void;
  consume: () => void;
}

export const useMapCommandStore = create<MapCommandState>((set) => ({
  target: null,
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
}));

