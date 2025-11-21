import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { sendChatMessage } from '../api/chat';
import { useAuthStore } from '../stores/auth-store';
import { useChatKeyStore } from '../stores/chat-key-store';
import { useChatStore } from '../stores/chat-store';
import { encryptText, parseKeyInput } from '../utils/chat-crypto';

export function ChatPage() {
  const user = useAuthStore((state) => state.user);
  const { messages, sendLocal, popupEnabled, setPopupEnabled, updateStatus } = useChatStore();
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

  const currentSiteId = user?.siteAccess?.[0]?.siteId ?? undefined;
  const activeKey = currentSiteId ? getKey(currentSiteId) : undefined;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !user) return;
    const siteId = currentSiteId;
    const role = user.role;
    const useKey = activeKey;
    try {
      setKeyError(null);
      let cipherText: string | undefined;
      if (useKey) {
        cipherText = await encryptText(useKey, trimmed);
      }
      const tempId = sendLocal(trimmed, user.email ?? 'me', siteId, role, 'pending');
      setText('');
      const response = await sendChatMessage({
        siteId,
        encrypted: Boolean(useKey),
        cipherText,
        text: useKey ? undefined : trimmed,
      });

      const ts = Date.parse(response.ts);
      updateStatus(tempId, 'sent', response.id, Number.isFinite(ts) ? ts : undefined);
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : 'Failed to send message');
      const now = Date.now();
      const lastId = messages[messages.length - 1]?.id;
      if (lastId) {
        updateStatus(lastId, 'failed', undefined, now);
      }
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
