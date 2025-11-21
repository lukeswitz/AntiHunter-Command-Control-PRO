import { create } from 'zustand';

export type ChatMessage = {
  id: string;
  text: string;
  from: string;
  role?: string;
  siteId?: string;
  ts: number;
  origin: 'self' | 'remote';
  status?: 'pending' | 'sent' | 'failed';
  encrypted?: boolean;
  cipherText?: string;
  decryptError?: boolean;
};

type ChatState = {
  messages: ChatMessage[];
  popupEnabled: boolean;
  addIncoming: (message: Omit<ChatMessage, 'origin' | 'id'> & { id?: string }) => void;
  sendLocal: (
    text: string,
    from: string,
    siteId?: string,
    role?: string,
    status?: ChatMessage['status'],
    idOverride?: string,
  ) => string;
  updateStatus: (id: string, status: ChatMessage['status'], newId?: string, ts?: number) => void;
  clearLocal: () => void;
  clearAllRemote: () => void;
  setPopupEnabled: (enabled: boolean) => void;
};

const makeId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `msg-${Math.random().toString(16).slice(2)}`;

export const useChatStore = create<ChatState>((set, _get) => ({
  messages: [],
  popupEnabled: true,
  addIncoming: (message) => {
    const id = message.id ?? makeId();
    set((state) => {
      if (state.messages.some((existing) => existing.id === id)) {
        return { messages: state.messages };
      }
      const next: ChatMessage = {
        ...message,
        id,
        origin: 'remote',
        status: 'sent',
      };
      return {
        messages: [...state.messages, next].slice(-200),
      };
    });
  },
  sendLocal: (text, from, siteId, role, status = 'pending', idOverride) => {
    const id = idOverride ?? makeId();
    const now = Date.now();
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id,
          text,
          from,
          siteId,
          role,
          ts: now,
          origin: 'self' as const,
          status,
        },
      ].slice(-200),
    }));
    return id;
  },
  updateStatus: (id, status, newId, ts) =>
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id
          ? ({
              ...msg,
              id: newId ?? msg.id,
              status,
              ts: ts ?? msg.ts,
            } as ChatMessage)
          : msg,
      ),
    })),
  clearLocal: () => set({ messages: [] }),
  clearAllRemote: () => set({ messages: [] }),
  setPopupEnabled: (enabled) => set({ popupEnabled: enabled }),
}));
