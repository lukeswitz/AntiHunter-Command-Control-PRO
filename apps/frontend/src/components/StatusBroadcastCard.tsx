import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { apiClient } from '../api/client';
import type { AppSettings } from '../api/types';

interface BroadcastResult {
  at: string;
  sent: boolean;
  frame?: string;
  reason?: string;
}

interface Props {
  className: string;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  canSend: boolean;
}

export function StatusBroadcastCard({ className, settings, onChange, canSend }: Props) {
  const queryClient = useQueryClient();
  const [minutes, setMinutes] = useState(
    String(Math.round(settings.statusBroadcastIntervalSec / 60)),
  );

  useEffect(() => {
    setMinutes(String(Math.round(settings.statusBroadcastIntervalSec / 60)));
  }, [settings.statusBroadcastIntervalSec]);

  const last = useQuery({
    queryKey: ['status-broadcast'],
    queryFn: () => apiClient.get<{ last: BroadcastResult | null }>('/status-broadcast'),
    refetchInterval: 30_000,
  });

  const send = useMutation({
    mutationFn: () => apiClient.post<BroadcastResult>('/status-broadcast/send'),
    onSuccess: (result) => queryClient.setQueryData(['status-broadcast'], { last: result }),
  });

  const commitMinutes = () => {
    const value = Math.min(60, Math.max(1, Math.round(Number(minutes))));
    if (!Number.isFinite(value)) {
      return;
    }
    setMinutes(String(value));
    if (value * 60 !== settings.statusBroadcastIntervalSec) {
      onChange({ statusBroadcastIntervalSec: value * 60 });
    }
  };

  const result = last.data?.last;

  return (
    <section className={className}>
      <header>
        <h2>Mesh Status Broadcast</h2>
        <p>Announce this command post on the mesh like a sensor STATUS reply.</p>
      </header>
      <div className="config-card__body">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.statusBroadcastEnabled}
            onChange={(event) => onChange({ statusBroadcastEnabled: event.target.checked })}
          />
          Broadcast status on a timer
        </label>
        <div className="config-row">
          <span className="config-label">Every (minutes)</span>
          <input
            type="number"
            min={1}
            max={60}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            onBlur={commitMinutes}
          />
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.statusBroadcastGps}
            onChange={(event) => onChange({ statusBroadcastGps: event.target.checked })}
          />
          Include GPS position
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.statusReplyEnabled}
            onChange={(event) => onChange({ statusReplyEnabled: event.target.checked })}
          />
          Answer @ALL STATUS requests
        </label>
        {canSend ? (
          <div className="config-row">
            <button
              type="button"
              className="control-chip"
              disabled={send.isPending}
              onClick={() => send.mutate()}
            >
              Send now
            </button>
          </div>
        ) : null}
        {result ? (
          <p className="config-hint">
            {result.sent ? 'Last sent' : 'Not sent'} {new Date(result.at).toLocaleTimeString()}
            {result.reason ? ` — ${result.reason}` : ''}
            {result.frame ? (
              <>
                <br />
                <code>{result.frame}</code>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}
