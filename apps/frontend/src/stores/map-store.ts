import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MapPreferencesState {
  fitEnabled: boolean;
  trailsEnabled: boolean;
  radiusEnabled: boolean;
  followEnabled: boolean;
  targetsEnabled: boolean;
  coverageEnabled: boolean;
  geofencesEnabled: boolean;
  adsbEnabled: boolean;
  adsbMuted: boolean;
  acarsEnabled: boolean;
  acarsMuted: boolean;
  mapStyle: string;
  showAdsbTracksLowRes: boolean;
  showAdsbPhotosLowRes: boolean;
  setFitEnabled: (value: boolean) => void;
  toggleTrails: () => void;
  toggleRadius: () => void;
  toggleFollow: () => void;
  toggleTargets: () => void;
  toggleCoverage: () => void;
  toggleGeofences: () => void;
  toggleAdsb: () => void;
  toggleAdsbMuted: () => void;
  toggleAcars: () => void;
  toggleAcarsMuted: () => void;
  setMapStyle: (style: string) => void;
  toggleShowAdsbTracksLowRes: () => void;
  toggleShowAdsbPhotosLowRes: () => void;
}

const DEFAULT_STATE: Pick<
  MapPreferencesState,
  | 'trailsEnabled'
  | 'radiusEnabled'
  | 'followEnabled'
  | 'targetsEnabled'
  | 'coverageEnabled'
  | 'geofencesEnabled'
  | 'adsbEnabled'
  | 'adsbMuted'
  | 'acarsEnabled'
  | 'acarsMuted'
  | 'showAdsbTracksLowRes'
  | 'showAdsbPhotosLowRes'
  | 'mapStyle'
  | 'fitEnabled'
> = {
  fitEnabled: false,
  trailsEnabled: true,
  radiusEnabled: true,
  followEnabled: false,
  targetsEnabled: true,
  coverageEnabled: false,
  geofencesEnabled: true,
  adsbEnabled: false,
  adsbMuted: false,
  acarsEnabled: false,
  acarsMuted: false,
  showAdsbTracksLowRes: true,
  showAdsbPhotosLowRes: true,
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
      toggleGeofences: () => set((state) => ({ geofencesEnabled: !state.geofencesEnabled })),
      toggleAdsb: () => set((state) => ({ adsbEnabled: !state.adsbEnabled })),
      toggleAdsbMuted: () => set((state) => ({ adsbMuted: !state.adsbMuted })),
      toggleAcars: () => set((state) => ({ acarsEnabled: !state.acarsEnabled })),
      toggleAcarsMuted: () => set((state) => ({ acarsMuted: !state.acarsMuted })),
      setMapStyle: (style) => set({ mapStyle: style }),
      toggleShowAdsbTracksLowRes: () =>
        set((state) => ({ showAdsbTracksLowRes: !state.showAdsbTracksLowRes })),
      toggleShowAdsbPhotosLowRes: () =>
        set((state) => ({ showAdsbPhotosLowRes: !state.showAdsbPhotosLowRes })),
    }),
    {
      name: 'map-preferences',
      version: 4,
      partialize: (state) => ({
        fitEnabled: state.fitEnabled,
        trailsEnabled: state.trailsEnabled,
        radiusEnabled: state.radiusEnabled,
        followEnabled: state.followEnabled,
        targetsEnabled: state.targetsEnabled,
        coverageEnabled: state.coverageEnabled,
        geofencesEnabled: state.geofencesEnabled,
        adsbEnabled: state.adsbEnabled,
        adsbMuted: state.adsbMuted,
        acarsEnabled: state.acarsEnabled,
        acarsMuted: state.acarsMuted,
        showAdsbTracksLowRes: state.showAdsbTracksLowRes,
        showAdsbPhotosLowRes: state.showAdsbPhotosLowRes,
        mapStyle: state.mapStyle,
      }),
    },
  ),
);
