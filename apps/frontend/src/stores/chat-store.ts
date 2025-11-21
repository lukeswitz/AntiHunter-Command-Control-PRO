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
  sendLocal: (text: string, from: string, siteId?: string, role?: string) => void;
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
    set((state) => ({
      messages: [
        ...state.messages,
        {
          ...message,
          id,
          origin: 'remote',
          status: 'sent',
        },
      ].slice(-200),
    }));
  },
  sendLocal: (text, from, siteId, role) => {
    const id = makeId();
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
          origin: 'self',
          status: 'sent',
        },
      ].slice(-200),
    }));
  },
  setPopupEnabled: (enabled) => set({ popupEnabled: enabled }),
}));
