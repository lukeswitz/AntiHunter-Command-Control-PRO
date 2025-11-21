import { create } from 'zustand';

const STORAGE_KEY = 'ahcc:chatKeys';

type ChatKeyState = {
  keys: Record<string, string>;
  setKey: (siteId: string, key: string) => void;
  getKey: (siteId?: string) => string | undefined;
};

const loadKeys = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
};

export const useChatKeyStore = create<ChatKeyState>((set, get) => ({
  keys: loadKeys(),
  setKey: (siteId, key) => {
    set((state) => {
      const next = { ...state.keys, [siteId]: key };
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
      return { keys: next };
    });
  },
  getKey: (siteId) => {
    if (!siteId) return undefined;
    return get().keys[siteId];
  },
}));
