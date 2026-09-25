import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { apiClient } from '../api/client';

interface RadioInfo {
  ownsPort: boolean;
  connected: boolean;
  radio: {
    num?: number;
    shortName?: string;
    longName?: string;
    lat?: number;
    lon?: number;
    positionAt?: number;
    batteryLevel?: number;
    deviceTime?: number;
    deviceTimeAt?: number;
  };
  meshNodeCount: number;
  config: {
    display?: { screenOnSecs: number };
    bluetooth?: { enabled: boolean; mode: number };
    position?: { gpsMode: number; fixedPosition: boolean; positionBroadcastSecs: number };
  };
}

interface Props {
  className: string;
  role?: string;
}

const GPS_MODES = ['Off', 'On', 'No GPS (use fixed position)'];

export function RadioCard({ className, role }: Props) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [screenSecs, setScreenSecs] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const isAdmin = role === 'ADMIN';
  const canOperate = isAdmin || role === 'OPERATOR';

  const info = useQuery({
    queryKey: ['radio'],
    queryFn: () => apiClient.get<RadioInfo>('/radio'),
    refetchInterval: 10_000,
  });

  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; done: string }) =>
      apiClient.post(`/radio/${path}`, body ?? {}),
    onSuccess: (_data, { done }) => {
      setMessage({ ok: true, text: done });
      void queryClient.invalidateQueries({ queryKey: ['radio'] });
    },
    onError: (error) =>
      setMessage({ ok: false, text: error instanceof Error ? error.message : 'Failed' }),
  });

  const run = (path: string, done: string, body?: unknown, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) {
      return;
    }
    setMessage(null);
    action.mutate({ path, body, done });
  };

  const data = info.data;
  const radio = data?.radio;
  const clockOffset =
    radio?.deviceTime && radio.deviceTimeAt
      ? Math.round(radio.deviceTime - radio.deviceTimeAt / 1000)
      : null;
  const busy = action.isPending;

  return (
    <section className={className}>
      <header>
        <h2>Radio</h2>
        <p>The Meshtastic radio attached to this command post.</p>
      </header>
      <div className="config-card__body">
        {!data ? (
          <p className="config-hint">Loading.</p>
        ) : !data.connected ? (
          <p className="config-hint">Serial port not connected.</p>
        ) : (
          <>
            <div className="config-row">
              <span className="config-label">Radio</span>
              <span>
                {radio?.longName ?? 'Not identified yet'}
                {radio?.shortName ? ` (${radio.shortName})` : ''}
                {radio?.num ? ` · !${radio.num.toString(16)}` : ''}
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Mesh nodes known</span>
              <span>{data.meshNodeCount}</span>
            </div>
            {radio?.batteryLevel ? (
              <div className="config-row">
                <span className="config-label">Battery</span>
                <span>{radio.batteryLevel}%</span>
              </div>
            ) : null}
            {clockOffset !== null ? (
              <div className="config-row">
                <span className="config-label">Radio clock</span>
                <span>
                  {Math.abs(clockOffset) <= 2
                    ? 'In sync'
                    : `${Math.abs(clockOffset)} s ${clockOffset > 0 ? 'ahead' : 'behind'}`}
                </span>
              </div>
            ) : null}
            {canOperate ? (
              <div className="radio-actions">
                <button
                  type="button"
                  className="control-chip"
                  disabled={busy}
                  onClick={() => run('refresh', 'Asked the radio to resend its settings.')}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="control-chip"
                  disabled={busy}
                  onClick={() => run('sync-time', 'Radio clock set to this computer.')}
                >
                  Sync clock
                </button>
                <button
                  type="button"
                  className="control-chip"
                  disabled={busy}
                  onClick={() =>
                    run('request-node-info', 'Asked all nodes to announce themselves.')
                  }
                >
                  Find nodes
                </button>
                <button
                  type="button"
                  className="control-chip"
                  disabled={busy}
                  onClick={() => run('request-telemetry', 'Asked the radio for battery status.')}
                >
                  Read battery
                </button>
              </div>
            ) : null}
            {isAdmin ? (
              <>
                <div className="config-row">
                  <span className="config-label">GPS</span>
                  <select
                    value={data.config.position?.gpsMode ?? ''}
                    disabled={busy || !data.config.position}
                    onChange={(event) =>
                      run('gps-mode', 'GPS setting sent.', { gpsMode: Number(event.target.value) })
                    }
                  >
                    {!data.config.position ? <option value="">Not loaded</option> : null}
                    {GPS_MODES.map((label, index) => (
                      <option key={label} value={index}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="config-row">
                  <span className="config-label">Fixed position</span>
                  <span className="radio-actions">
                    <input
                      placeholder="Latitude"
                      value={lat}
                      onChange={(event) => setLat(event.target.value)}
                    />
                    <input
                      placeholder="Longitude"
                      value={lon}
                      onChange={(event) => setLon(event.target.value)}
                    />
                    <button
                      type="button"
                      className="control-chip"
                      disabled={busy || !lat || !lon}
                      onClick={() =>
                        run('fixed-position', 'Fixed position sent.', {
                          lat: Number(lat),
                          lon: Number(lon),
                        })
                      }
                    >
                      Set
                    </button>
                    {data.config.position?.fixedPosition ? (
                      <button
                        type="button"
                        className="control-chip"
                        disabled={busy}
                        onClick={() => run('fixed-position/remove', 'Fixed position removed.')}
                      >
                        Clear
                      </button>
                    ) : null}
                  </span>
                </div>
                <div className="config-row">
                  <span className="config-label">Screen on (seconds)</span>
                  <span className="radio-actions">
                    <input
                      type="number"
                      min={0}
                      placeholder={String(data.config.display?.screenOnSecs ?? '')}
                      value={screenSecs}
                      onChange={(event) => setScreenSecs(event.target.value)}
                    />
                    <button
                      type="button"
                      className="control-chip"
                      disabled={busy || screenSecs === '' || !data.config.display}
                      onClick={() =>
                        run('display', 'Screen timeout sent.', { screenOnSecs: Number(screenSecs) })
                      }
                    >
                      Set
                    </button>
                  </span>
                </div>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={data.config.bluetooth?.enabled ?? false}
                    disabled={busy || !data.config.bluetooth}
                    onChange={(event) =>
                      run('bluetooth', 'Bluetooth setting sent.', {
                        enabled: event.target.checked,
                      })
                    }
                  />
                  Radio Bluetooth
                </label>
                <div className="radio-actions">
                  <button
                    type="button"
                    className="control-chip"
                    disabled={busy}
                    onClick={() =>
                      run('reboot', 'Radio rebooting.', { seconds: 2 }, 'Reboot the radio?')
                    }
                  >
                    Reboot
                  </button>
                  <button
                    type="button"
                    className="control-chip"
                    disabled={busy}
                    onClick={() =>
                      run(
                        'shutdown',
                        'Radio shutting down.',
                        { seconds: 2 },
                        'Shut the radio down? Use Wake to start it again.',
                      )
                    }
                  >
                    Shut down
                  </button>
                  <button
                    type="button"
                    className="control-chip"
                    disabled={busy}
                    onClick={() => run('wake', 'Reset signal sent.')}
                  >
                    Wake
                  </button>
                  <button
                    type="button"
                    className="control-chip"
                    disabled={busy}
                    onClick={() =>
                      run(
                        'nodedb-reset',
                        'Radio node list cleared.',
                        undefined,
                        'Clear the radio’s list of known nodes?',
                      )
                    }
                  >
                    Clear node list
                  </button>
                </div>
              </>
            ) : null}
          </>
        )}
        {message ? (
          <p className={message.ok ? 'config-hint' : 'config-hint config-hint--warn'}>
            {message.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
