import { useMemo, useState } from 'react';

import { TerminalEntry, useTerminalStore } from '../stores/terminal-store';

const levelToClass: Record<TerminalEntry['level'], string> = {
  info: '',
  notice: 'terminal-entry--notice',
  alert: 'terminal-entry--alert',
  critical: 'terminal-entry--critical',
};

export function TerminalDrawer() {
  const entries = useTerminalStore((state) => state.entries);
  const clearEntries = useTerminalStore((state) => state.clear);
  const [showRaw, setShowRaw] = useState(false);

  const filteredEntries = useMemo(() => {
    if (showRaw) {
      return entries;
    }
    return entries.filter((entry) => entry.source !== 'raw');
  }, [entries, showRaw]);

  const isScrollable = filteredEntries.length > 50;
  const displayEntries = filteredEntries;

  return (
    <section className="terminal-drawer">
      <header className="terminal-drawer__header">
        <span>Terminal &amp; Events</span>
        <div className="terminal-drawer__actions">
          <button type="button" className="control-chip" onClick={clearEntries}>
            Clear
          </button>
          <button
            type="button"
            className={`control-chip ${showRaw ? 'is-active' : ''}`}
            onClick={() => setShowRaw((value) => !value)}
          >
            {showRaw ? 'Hide Raw' : 'Show Raw'}
          </button>
        </div>
      </header>
      <div
        className={`terminal-drawer__list${isScrollable ? ' terminal-drawer__list--scroll' : ''}`}
      >
        {displayEntries.length === 0 ? (
          <div className="empty-state">
            <div>
              {entries.length === 0
                ? 'No events yet. Start a scan to see activity here.'
                : 'Raw-only events filtered. Enable "Show Raw" to view them.'}
            </div>
          </div>
        ) : (
          displayEntries.map((entry) => (
            <article
              key={entry.id}
              className={`terminal-entry ${levelToClass[entry.level]}`}
              aria-live="polite"
            >
              <div className="terminal-entry__meta">
                <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                {entry.source && (
                  <span className={`terminal-entry__tag terminal-entry__tag--${entry.source}`}>
                    {entry.source}
                  </span>
                )}
                {entry.siteId && <span>Site: {entry.siteId}</span>}
              </div>
              <p className="terminal-entry__message">{entry.message}</p>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
