import { create } from 'zustand';

interface MapPreferencesState {
  trailsEnabled: boolean;
  radiusEnabled: boolean;
  followEnabled: boolean;
  targetsEnabled: boolean;
  coverageEnabled: boolean;
  toggleTrails: () => void;
  toggleRadius: () => void;
  toggleFollow: () => void;
  toggleTargets: () => void;
  toggleCoverage: () => void;
}

export const useMapPreferences = create<MapPreferencesState>((set) => ({
  trailsEnabled: true,
  radiusEnabled: true,
  followEnabled: false,
  targetsEnabled: true,
  coverageEnabled: false,
  toggleTrails: () => set((state) => ({ trailsEnabled: !state.trailsEnabled })),
  toggleRadius: () => set((state) => ({ radiusEnabled: !state.radiusEnabled })),
  toggleFollow: () => set((state) => ({ followEnabled: !state.followEnabled })),
  toggleTargets: () => set((state) => ({ targetsEnabled: !state.targetsEnabled })),
  toggleCoverage: () => set((state) => ({ coverageEnabled: !state.coverageEnabled })),
}));
