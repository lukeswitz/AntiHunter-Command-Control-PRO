import { create } from 'zustand';

export type TerminalLevel = 'info' | 'notice' | 'alert' | 'critical';

export interface TerminalEntry {
  id: string;
  timestamp: string;
  message: string;
  level: TerminalLevel;
  source?: string;
  siteId?: string;
}

interface TerminalStore {
  entries: TerminalEntry[];
  maxEntries: number;
  addEntry: (entry: Omit<TerminalEntry, 'id' | 'timestamp'> & { timestamp?: string }) => void;
  clear: () => void;
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  entries: [],
  maxEntries: 200,
  addEntry: (entry) =>
    set((state) => {
      const now = entry.timestamp ?? new Date().toISOString();
      const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const nextEntry: TerminalEntry = { ...entry, id, timestamp: now };
      const last = state.entries[0];
      if (
        last &&
        last.level === nextEntry.level &&
        last.source === nextEntry.source &&
        last.siteId === nextEntry.siteId &&
        last.message === nextEntry.message
      ) {
        return state;
      }
      const next = [nextEntry, ...state.entries].slice(0, state.maxEntries);
      return { entries: next };
    }),
  clear: () => set({ entries: [] }),
}));
