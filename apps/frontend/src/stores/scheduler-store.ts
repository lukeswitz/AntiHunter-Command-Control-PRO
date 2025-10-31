import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface SchedulerEvent {
  id: string;
  templateId: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm (24h)
  note?: string;
  enabled: boolean;
  lastRunAt?: string | null;
  createdAt: string;
}

export interface SchedulerLogEntry {
  id: string;
  timestamp: string;
  message: string;
  level: 'info' | 'success' | 'error';
}

interface SchedulerState {
  active: boolean;
  events: SchedulerEvent[];
  logs: SchedulerLogEntry[];
  addEvent: (event: SchedulerEvent) => void;
  updateEvent: (id: string, update: Partial<SchedulerEvent>) => void;
  deleteEvent: (id: string) => void;
  copyDay: (sourceDate: string, targetDate: string) => void;
  copyWeek: (weekStartDate: string) => void;
  setActive: (active: boolean) => void;
  appendLog: (entry: SchedulerLogEntry) => void;
  markExecuted: (id: string, executedAt: string) => void;
  clearLogs: () => void;
}

const MAX_LOG_ENTRIES = 300;

export const useSchedulerStore = create<SchedulerState>()(
  persist(
    (set, _get) => ({
      active: false,
      events: [],
      logs: [],
      addEvent: (event) => {
        set((state) => ({
          events: [...state.events, event],
        }));
      },
      updateEvent: (id, update) => {
        set((state) => ({
          events: state.events.map((event) => (event.id === id ? { ...event, ...update } : event)),
        }));
      },
      deleteEvent: (id) => {
        set((state) => ({
          events: state.events.filter((event) => event.id !== id),
        }));
      },
      copyDay: (sourceDate, targetDate) => {
        set((state) => {
          const clones = state.events
            .filter((event) => event.date === sourceDate)
            .map((event) => ({
              ...event,
              id: `sched-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
              date: targetDate,
              lastRunAt: null,
              createdAt: new Date().toISOString(),
            }));
          return {
            events: [...state.events, ...clones],
          };
        });
      },
      copyWeek: (weekStartDate) => {
        set((state) => {
          const start = new Date(weekStartDate);
          const clones: SchedulerEvent[] = [];
          for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
            const sourceDate = new Date(start);
            sourceDate.setDate(start.getDate() + dayOffset);
            const targetDate = new Date(sourceDate);
            targetDate.setDate(sourceDate.getDate() + 7);
            const sourceKey = sourceDate.toISOString().slice(0, 10);
            const targetKey = targetDate.toISOString().slice(0, 10);
            state.events
              .filter((event) => event.date === sourceKey)
              .forEach((event) => {
                clones.push({
                  ...event,
                  id: `sched-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
                  date: targetKey,
                  lastRunAt: null,
                  createdAt: new Date().toISOString(),
                });
              });
          }
          return {
            events: [...state.events, ...clones],
          };
        });
      },
      setActive: (active) => set({ active }),
      appendLog: (entry) => {
        set((state) => {
          const next = [...state.logs, entry].slice(-MAX_LOG_ENTRIES);
          return { logs: next };
        });
      },
      markExecuted: (id, executedAt) => {
        set((state) => ({
          events: state.events.map((event) =>
            event.id === id ? { ...event, lastRunAt: executedAt } : event,
          ),
        }));
      },
      clearLogs: () => set({ logs: [] }),
    }),
    {
      name: 'command-center.scheduler',
    },
  ),
);
