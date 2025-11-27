import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MapPreferencesState {
  fitEnabled: boolean;
  trailsEnabled: boolean;
  radiusEnabled: boolean;
  followEnabled: boolean;
  targetsEnabled: boolean;
  coverageEnabled: boolean;
  adsbEnabled: boolean;
  mapStyle: string;
  setFitEnabled: (value: boolean) => void;
  toggleTrails: () => void;
  toggleRadius: () => void;
  toggleFollow: () => void;
  toggleTargets: () => void;
  toggleCoverage: () => void;
  toggleAdsb: () => void;
  setMapStyle: (style: string) => void;
}

const DEFAULT_STATE: Pick<
  MapPreferencesState,
  | 'trailsEnabled'
  | 'radiusEnabled'
  | 'followEnabled'
  | 'targetsEnabled'
  | 'coverageEnabled'
  | 'adsbEnabled'
  | 'mapStyle'
  | 'fitEnabled'
> = {
  fitEnabled: false,
  trailsEnabled: true,
  radiusEnabled: true,
  followEnabled: false,
  targetsEnabled: true,
  coverageEnabled: false,
  adsbEnabled: false,
  mapStyle: 'osm',
};

export const useMapPreferences = create<MapPreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_STATE,
      setFitEnabled: (value) => set({ fitEnabled: value }),
      toggleTrails: () => set((state) => ({ trailsEnabled: !state.trailsEnabled })),
      toggleRadius: () => set((state) => ({ radiusEnabled: !state.radiusEnabled })),
      toggleFollow: () => set((state) => ({ followEnabled: !state.followEnabled })),
      toggleTargets: () => set((state) => ({ targetsEnabled: !state.targetsEnabled })),
      toggleCoverage: () => set((state) => ({ coverageEnabled: !state.coverageEnabled })),
      toggleAdsb: () => set((state) => ({ adsbEnabled: !state.adsbEnabled })),
      setMapStyle: (style) => set({ mapStyle: style }),
    }),
    {
      name: 'map-preferences',
      version: 1,
      partialize: (state) => ({
        fitEnabled: state.fitEnabled,
        trailsEnabled: state.trailsEnabled,
        radiusEnabled: state.radiusEnabled,
        followEnabled: state.followEnabled,
        targetsEnabled: state.targetsEnabled,
        coverageEnabled: state.coverageEnabled,
        adsbEnabled: state.adsbEnabled,
        mapStyle: state.mapStyle,
      }),
    },
  ),
);
