import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { useAuthStore } from '../stores/auth-store';
import { useChatKeyStore } from '../stores/chat-key-store';
import { useChatStore } from '../stores/chat-store';

async function encryptText(keyBase64: string, plaintext: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
  return `${ivB64}:${ctB64}`;
}

async function decryptText(keyBase64: string, payload: string): Promise<string> {
  const [ivPart, ctPart] = payload.split(':');
  if (!ivPart || !ctPart) throw new Error('Invalid payload');
  const iv = Uint8Array.from(atob(ivPart), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctPart), (c) => c.charCodeAt(0));
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
  return new TextDecoder().decode(plainBuf);
}

function parseKeyInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter a key.');
  // Accept hex or base64; normalize to base64
  const isHex = /^[0-9a-fA-F]+$/.test(trimmed);
  if (isHex) {
    if (trimmed.length !== 64) throw new Error('Hex key must be 64 characters (32 bytes).');
    const bytes = trimmed.match(/.{1,2}/g)?.map((pair) => parseInt(pair, 16)) ?? [];
    return btoa(String.fromCharCode(...bytes));
  }
  // Otherwise treat as base64
  const bytes = Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) {
    throw new Error('Base64 key must decode to 32 bytes.');
  }
  return trimmed;
}

export function ChatPage() {
  const user = useAuthStore((state) => state.user);
  const { messages, sendLocal, addIncoming, popupEnabled, setPopupEnabled } = useChatStore();
  const { getKey, setKey } = useChatKeyStore();
  const [text, setText] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const sortedMessages = useMemo(() => [...messages].sort((a, b) => a.ts - b.ts), [messages]);

  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [sortedMessages.length]);

  const currentSiteId = user?.siteId ?? undefined;
  const activeKey = currentSiteId ? getKey(currentSiteId) : undefined;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !user) return;
    const siteId = user.siteId ?? undefined;
    const role = user.role;
    const useKey = activeKey;
    try {
      let cipherText: string | undefined;
      if (useKey) {
        cipherText = await encryptText(useKey, trimmed);
      }
      sendLocal(trimmed, user.email ?? 'me', siteId, role);
      setText('');
      // Stub for remote echo to demonstrate popup/decrypt; replace with MQTT receive.
      window.setTimeout(async () => {
        try {
          const decrypted = useKey ? await decryptText(useKey, cipherText ?? '') : trimmed;
          addIncoming({
            text: decrypted,
            from: 'Echo Bot',
            ts: Date.now(),
            role: 'SYSTEM',
            siteId,
            cipherText,
            encrypted: Boolean(useKey),
          });
        } catch {
          addIncoming({
            text: trimmed,
            from: 'Echo Bot',
            ts: Date.now(),
            role: 'SYSTEM',
            siteId,
            cipherText,
            encrypted: Boolean(useKey),
            decryptError: true,
          });
        }
      }, 300);
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : 'Encryption failed');
    }
  };

  return (
    <section className="panel chat-page">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Operator Chat</h1>
          <p className="panel__subtitle">
            Secure operator chat over MQTT. Incoming messages appear here and can trigger pop-ups.
          </p>
        </div>
        <div className="chat-controls">
          <label className="control-chip">
            <input
              type="checkbox"
              checked={popupEnabled}
              onChange={(event) => setPopupEnabled(event.target.checked)}
            />
            Pop up on new messages
          </label>
          <div className="chat-key">
            <input
              className="control-input"
              placeholder="Paste 32-byte key (base64 or hex)"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value.trim())}
            />
            <button
              type="button"
              className="control-chip"
              onClick={() => {
                if (!currentSiteId) {
                  setKeyError('No site selected for chat key.');
                  return;
                }
                try {
                  const normalized = parseKeyInput(keyInput);
                  setKey(currentSiteId, normalized);
                  setKeyError(null);
                } catch {
                  setKeyError('Invalid key. Use 32-byte base64 or 64-char hex.');
                }
              }}
            >
              Save Key
            </button>
          </div>
          {keyError ? <span className="form-error">{keyError}</span> : null}
        </div>
      </header>

      <div className="chat-body">
        <div className="chat-messages" ref={listRef}>
          {sortedMessages.length === 0 ? (
            <div className="empty-state">No messages yet. Start the conversation.</div>
          ) : (
            sortedMessages.map((msg) => (
              <div
                key={msg.id}
                className={`chat-message ${msg.origin === 'self' ? 'chat-message--self' : ''}`}
              >
                <div className="chat-message__meta">
                  <strong>{msg.from}</strong>
                  {msg.role ? <span className="chat-message__role">{msg.role}</span> : null}
                  <span className="chat-message__time">
                    {new Date(msg.ts).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="chat-message__text">{msg.text}</div>
              </div>
            ))
          )}
        </div>
        <form className="chat-compose" onSubmit={handleSubmit}>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type a message and press Enter to send. Shift+Enter for newline."
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSubmit(event as unknown as FormEvent);
              }
            }}
          />
          <button type="submit" className="control-chip" disabled={!text.trim()}>
            Send
          </button>
        </form>
      </div>
    </section>
  );
}
