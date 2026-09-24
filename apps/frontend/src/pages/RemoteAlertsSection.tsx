import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toDataURL } from 'qrcode';
import { ReactNode, useEffect, useState } from 'react';

import { PushNotificationsCard, WebhooksSection } from './WebhooksSection';
import {
  AlertChannel,
  AlertTier,
  clearRemoteAlertSecret,
  eraseMatter,
  generateVapidKeys,
  getMatterStatus,
  fetchSignalLinkQr,
  getRemoteAlertConfig,
  getSignalStatus,
  listAlertSources,
  listPushSubscriptions,
  RemoteAlertConfig,
  RemoteAlertConfigUpdate,
  removePushSubscription,
  restartMatter,
  testAlertChannel,
  updateRemoteAlertConfig,
} from '../api/remote-alerts';
import { useAuthStore } from '../stores/auth-store';

interface FormState {
  tsAllowedLogins: string;
  vapidSubject: string;
  ntfyEnabled: boolean;
  ntfyUrl: string;
  ntfyToken: string;
  signalEnabled: boolean;
  signalApiUrl: string;
  signalNumber: string;
  signalRecipients: string;
  matrixEnabled: boolean;
  matrixHomeserverUrl: string;
  matrixAccessToken: string;
  matrixRoomId: string;
  matterEnabled: boolean;
  matterLayout: 'bridge' | 'flat';
}

function toForm(config: RemoteAlertConfig): FormState {
  return {
    tsAllowedLogins: config.tsAllowedLogins.join('\n'),
    vapidSubject: config.vapidSubject ?? '',
    ntfyEnabled: config.ntfyEnabled,
    ntfyUrl: config.ntfyUrl ?? '',
    ntfyToken: '',
    signalEnabled: config.signalEnabled,
    signalApiUrl: config.signalApiUrl ?? '',
    signalNumber: config.signalNumber ?? '',
    signalRecipients: config.signalRecipients.join('\n'),
    matrixEnabled: config.matrixEnabled,
    matrixHomeserverUrl: config.matrixHomeserverUrl ?? '',
    matrixAccessToken: '',
    matrixRoomId: config.matrixRoomId ?? '',
    matterEnabled: config.matterEnabled,
    matterLayout: config.matterLayout,
  };
}

const lines = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function RemoteAlertsSection() {
  const isAdmin = useAuthStore((state) => state.user?.role === 'ADMIN');
  return (
    <div className="config-card__body remote-alerts">
      <PushNotificationsCard />
      {isAdmin ? (
        <AdminCards />
      ) : (
        <p className="empty-state">Only administrators can change remote access and alerts.</p>
      )}
    </div>
  );
}

function AdminCards() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['remote-alerts'], queryFn: getRemoteAlertConfig });
  const [form, setForm] = useState<FormState | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});

  useEffect(() => {
    if (configQuery.data) {
      setForm(toForm(configQuery.data));
    }
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: ({ patch }: { patch: RemoteAlertConfigUpdate; card: string }) =>
      updateRemoteAlertConfig(patch),
    onSuccess: (data, { card }) => {
      queryClient.setQueryData(['remote-alerts'], data);
      queryClient.invalidateQueries({ queryKey: ['remote-alerts-matter'] });
      setNotice((prev) => ({ ...prev, [card]: 'Saved.' }));
    },
    onError: (error, { card }) => setNotice((prev) => ({ ...prev, [card]: errorText(error) })),
  });

  const testMutation = useMutation({
    mutationFn: (channel: AlertChannel) => testAlertChannel(channel),
    onSuccess: (_data, channel) => setNotice((prev) => ({ ...prev, [channel]: 'Test sent.' })),
    onError: (error, channel) => setNotice((prev) => ({ ...prev, [channel]: errorText(error) })),
  });

  const clearSecretMutation = useMutation({
    mutationFn: clearRemoteAlertSecret,
    onSuccess: (data) => queryClient.setQueryData(['remote-alerts'], data),
  });

  if (configQuery.isLoading || !form || !configQuery.data) {
    return (
      <p className="empty-state">
        {configQuery.error ? errorText(configQuery.error) : 'Loading settings...'}
      </p>
    );
  }

  const config = configQuery.data;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const save = (card: string, patch: RemoteAlertConfigUpdate) =>
    saveMutation.mutate({ card, patch });
  const busy = saveMutation.isPending || testMutation.isPending;
  const noticeFor = (key: string) =>
    notice[key] ? <p className="config-hint">{notice[key]}</p> : null;

  return (
    <>
      <AlertLevelsCard
        tiers={config.alertTiers ?? {}}
        busy={busy}
        onSave={(alertTiers) => save('levels', { alertTiers })}
        notice={notice.levels}
      />

      <PushAdminCard
        config={config}
        onTest={() => testMutation.mutate('push')}
        busy={busy}
        notice={notice.push}
      />

      <ChannelRow
        title="Signal"
        on={config.signalEnabled && Boolean(config.signalNumber)}
        status={config.signalEnabled ? (config.signalNumber ? 'On' : 'Not linked') : 'Off'}
        hint="End-to-end encrypted. Link a dedicated Signal number; alerts go to a private AntiHunter group."
      >
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={form.signalEnabled}
            onChange={(event) => set('signalEnabled', event.target.checked)}
          />
          <span>Send alerts to Signal</span>
        </label>
        <SignalLink />
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={busy}
            onClick={() => save('signal', { signalEnabled: form.signalEnabled })}
          >
            Save
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={busy}
            onClick={() => testMutation.mutate('signal')}
          >
            Send test
          </button>
        </div>
        {noticeFor('signal')}
      </ChannelRow>

      <ChannelRow
        title="ntfy"
        on={config.ntfyEnabled && Boolean(config.ntfyUrl)}
        status={config.ntfyEnabled ? 'On' : 'Off'}
        hint="Your ntfy server can read alerts. Paste a topic URL and access token."
      >
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={form.ntfyEnabled}
            onChange={(event) => set('ntfyEnabled', event.target.checked)}
          />
          <span>Send alerts to ntfy</span>
        </label>
        <div className="form-grid">
          <label>
            <span>Topic URL</span>
            <input
              className="control-input"
              value={form.ntfyUrl}
              placeholder="https://ntfy.example.com/ahcc-alerts"
              onChange={(event) => set('ntfyUrl', event.target.value)}
            />
          </label>
          <label>
            <span>Access token</span>
            <input
              className="control-input"
              type="password"
              autoComplete="off"
              value={form.ntfyToken}
              placeholder={config.hasNtfyToken ? 'Saved (leave blank to keep)' : 'tk_...'}
              onChange={(event) => set('ntfyToken', event.target.value)}
            />
          </label>
        </div>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={busy}
            onClick={() => {
              save('ntfy', {
                ntfyEnabled: form.ntfyEnabled,
                ntfyUrl: form.ntfyUrl,
                ntfyToken: form.ntfyToken,
              });
              set('ntfyToken', '');
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={busy}
            onClick={() => testMutation.mutate('ntfy')}
          >
            Send test
          </button>
          {config.hasNtfyToken && (
            <button
              type="button"
              className="control-chip control-chip--danger"
              onClick={() => clearSecretMutation.mutate('ntfyToken')}
            >
              Remove token
            </button>
          )}
        </div>
        {noticeFor('ntfy')}
      </ChannelRow>

      <ChannelRow
        title="Matrix"
        on={config.matrixEnabled && config.hasMatrixAccessToken}
        status={config.matrixEnabled ? 'On' : 'Off'}
        hint="Your own homeserver, not end-to-end encrypted. Enter homeserver, room and a bot token."
      >
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={form.matrixEnabled}
            onChange={(event) => set('matrixEnabled', event.target.checked)}
          />
          <span>Send alerts to Matrix</span>
        </label>
        <div className="form-grid">
          <label>
            <span>Homeserver URL</span>
            <input
              className="control-input"
              value={form.matrixHomeserverUrl}
              placeholder="https://matrix.example.com"
              onChange={(event) => set('matrixHomeserverUrl', event.target.value)}
            />
          </label>
          <label>
            <span>Room ID</span>
            <input
              className="control-input"
              value={form.matrixRoomId}
              placeholder="!abc123:example.com"
              onChange={(event) => set('matrixRoomId', event.target.value)}
            />
          </label>
        </div>
        <label className="form-field">
          <span>Bot access token</span>
          <input
            className="control-input"
            type="password"
            autoComplete="off"
            value={form.matrixAccessToken}
            placeholder={config.hasMatrixAccessToken ? 'Saved (leave blank to keep)' : ''}
            onChange={(event) => set('matrixAccessToken', event.target.value)}
          />
        </label>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={busy}
            onClick={() => {
              save('matrix', {
                matrixEnabled: form.matrixEnabled,
                matrixHomeserverUrl: form.matrixHomeserverUrl,
                matrixRoomId: form.matrixRoomId,
                matrixAccessToken: form.matrixAccessToken,
              });
              set('matrixAccessToken', '');
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={busy}
            onClick={() => testMutation.mutate('matrix')}
          >
            Send test
          </button>
          {config.hasMatrixAccessToken && (
            <button
              type="button"
              className="control-chip control-chip--danger"
              onClick={() => clearSecretMutation.mutate('matrixAccessToken')}
            >
              Remove token
            </button>
          )}
        </div>
        {noticeFor('matrix')}
      </ChannelRow>

      <section className="remote-subsection">
        <div className="channel-row__head">
          <h3>Webhooks</h3>
        </div>
        <p className="field-hint">
          Discord, Slack, IFTTT or Home Assistant. Pick a preset and paste the URL.
        </p>
        <WebhooksSection />
      </section>

      <MatterCard
        enabled={form.matterEnabled}
        layout={form.matterLayout}
        onEnabled={(value) => set('matterEnabled', value)}
        onLayout={(value) => set('matterLayout', value)}
        onSave={() =>
          save('matter', { matterEnabled: form.matterEnabled, matterLayout: form.matterLayout })
        }
        onTest={() => testMutation.mutate('matter')}
        busy={busy}
        notice={notice.matter}
      />

      <ChannelRow
        title="Remote access (Tailscale)"
        on={config.tsAllowedLogins.length > 0}
        hint="Reach AHCC over your private tailnet. Only the listed Tailscale logins get in."
        status={
          config.tsAllowedLogins.length ? `${config.tsAllowedLogins.length} allowed` : 'Nobody'
        }
      >
        <label className="form-field">
          <span>Allowed Tailscale logins</span>
          <textarea
            className="control-input"
            rows={3}
            value={form.tsAllowedLogins}
            placeholder="you@example.com"
            onChange={(event) => set('tsAllowedLogins', event.target.value)}
          />
        </label>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={busy}
            onClick={() => save('tailscale', { tsAllowedLogins: lines(form.tsAllowedLogins) })}
          >
            Save
          </button>
        </div>
        {noticeFor('tailscale')}
      </ChannelRow>
    </>
  );
}

function ChannelRow(props: {
  title: string;
  status: string;
  on: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="remote-subsection">
      <div className="channel-row__head">
        <h3>{props.title}</h3>
        <span className={props.on ? 'badge badge--active' : 'badge'}>{props.status}</span>
      </div>
      {props.hint && <p className="field-hint">{props.hint}</p>}
      {props.children}
    </section>
  );
}

function SignalLink() {
  const statusQuery = useQuery({
    queryKey: ['remote-alerts-signal'],
    queryFn: getSignalStatus,
    refetchInterval: (query) => (query.state.data?.linkedNumber ? false : 4_000),
  });
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = statusQuery.data;

  useEffect(() => {
    if (status?.linkedNumber && qrUrl) {
      URL.revokeObjectURL(qrUrl);
      setQrUrl(null);
    }
  }, [status?.linkedNumber, qrUrl]);

  if (!status) {
    return <p className="config-hint">Checking Signal…</p>;
  }
  if (!status.reachable) {
    return <p className="config-hint">Signal connector not running.</p>;
  }
  if (status.linkedNumber) {
    return <p className="config-hint">Linked. Alerts go to the “AntiHunter Alerts” group.</p>;
  }
  return (
    <div className="form-field">
      <p className="config-hint config-hint--warn">
        Linking adds AHCC as a Signal device on this account. Use a dedicated Signal number, not
        your personal one. Keep the connector on the AHCC host only.
      </p>
      {qrUrl ? (
        <>
          <img src={qrUrl} alt="Signal link QR code" width={200} height={200} />
          <p className="config-hint">Signal → Settings → Linked devices → + → scan.</p>
        </>
      ) : (
        <button
          type="button"
          className="control-chip"
          onClick={() => {
            setError(null);
            fetchSignalLinkQr()
              .then((blob) => setQrUrl(URL.createObjectURL(blob)))
              .catch((err) => setError(errorText(err)));
          }}
        >
          Link Signal
        </button>
      )}
      {error && <p className="config-hint">{error}</p>}
    </div>
  );
}

function AlertLevelsCard(props: {
  tiers: Record<string, AlertTier>;
  busy: boolean;
  onSave: (tiers: Record<string, AlertTier>) => void;
  notice?: string;
}) {
  const sourcesQuery = useQuery({
    queryKey: ['remote-alerts-sources', props.tiers],
    queryFn: listAlertSources,
  });
  const [draft, setDraft] = useState<Record<string, AlertTier>>({});
  useEffect(() => {
    const next: Record<string, AlertTier> = {};
    for (const source of sourcesQuery.data ?? []) {
      next[source.key] = source.tier;
    }
    setDraft(next);
  }, [sourcesQuery.data]);

  const rows = sourcesQuery.data ?? [];
  const groups = [...new Set(rows.map((row) => row.group))];
  const setTier = (key: string, tier: AlertTier) => setDraft((prev) => ({ ...prev, [key]: tier }));

  return (
    <section className="remote-subsection">
      <div className="channel-row__head">
        <h3>Alert sources</h3>
      </div>
      <p className="field-hint">
        Notify sends to your channels. Critical also lights the Home critical sensor.
      </p>
      <div>
        <div className="table-scroll">
          <table className="data-table alert-sources-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Notify</th>
                <th>Critical</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group}>
                <tr className="alert-group-row">
                  <td colSpan={3}>{group}</td>
                </tr>
                {rows
                  .filter((row) => row.group === group)
                  .map((row) => {
                    const tier = draft[row.key] ?? 'off';
                    return (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Notify: ${row.label}`}
                            checked={tier !== 'off'}
                            onChange={(event) =>
                              setTier(row.key, event.target.checked ? 'alert' : 'off')
                            }
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Critical: ${row.label}`}
                            checked={tier === 'critical'}
                            disabled={tier === 'off'}
                            onChange={(event) =>
                              setTier(row.key, event.target.checked ? 'critical' : 'alert')
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            ))}
          </table>
        </div>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={props.busy}
            onClick={() => props.onSave(draft)}
          >
            Save levels
          </button>
        </div>
        {props.notice && <p className="config-hint">{props.notice}</p>}
      </div>
    </section>
  );
}

function PushAdminCard(props: {
  config: RemoteAlertConfig;
  onTest: () => void;
  busy: boolean;
  notice?: string;
}) {
  const queryClient = useQueryClient();
  const subsQuery = useQuery({
    queryKey: ['remote-alerts-push-subs'],
    queryFn: listPushSubscriptions,
  });
  const generateMutation = useMutation({
    mutationFn: generateVapidKeys,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-alerts'] });
      queryClient.invalidateQueries({ queryKey: ['remote-alerts-push-subs'] });
    },
  });
  const removeMutation = useMutation({
    mutationFn: removePushSubscription,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['remote-alerts-push-subs'] }),
  });
  const configured = Boolean(props.config.vapidPublicKey && props.config.hasVapidPrivateKey);

  return (
    <ChannelRow
      title="Phone push"
      on={Boolean(subsQuery.data?.length)}
      status={subsQuery.data?.length ? `${subsQuery.data.length} device(s)` : 'No devices'}
      hint="Each user enables push on their own device above. Manage keys and devices here."
    >
      <div>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={!configured || props.busy}
            onClick={props.onTest}
          >
            Send test to all devices
          </button>
          {configured && (
            <button
              type="button"
              className="control-chip control-chip--danger"
              disabled={generateMutation.isPending}
              onClick={() => {
                if (window.confirm('Sign out all devices from push?')) {
                  generateMutation.mutate();
                }
              }}
            >
              Reset keys
            </button>
          )}
        </div>
        {generateMutation.error && (
          <p className="config-hint">{errorText(generateMutation.error)}</p>
        )}
        {props.notice && <p className="config-hint">{props.notice}</p>}
        {subsQuery.data && subsQuery.data.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Service</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {subsQuery.data.map((sub) => (
                  <tr key={sub.endpoint}>
                    <td>{sub.userEmail}</td>
                    <td>{sub.service}</td>
                    <td>{new Date(sub.createdAt).toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        className="control-chip control-chip--danger"
                        onClick={() => removeMutation.mutate(sub.endpoint)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ChannelRow>
  );
}

function MatterCard(props: {
  enabled: boolean;
  layout: 'bridge' | 'flat';
  onEnabled: (value: boolean) => void;
  onLayout: (value: 'bridge' | 'flat') => void;
  onSave: () => void;
  onTest: () => void;
  busy: boolean;
  notice?: string;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ['remote-alerts-matter'],
    queryFn: getMatterStatus,
    refetchInterval: 5_000,
  });
  const restartMutation = useMutation({
    mutationFn: restartMatter,
    onSuccess: (data) => queryClient.setQueryData(['remote-alerts-matter'], data),
  });
  const eraseMutation = useMutation({
    mutationFn: eraseMatter,
    onSuccess: (data) => queryClient.setQueryData(['remote-alerts-matter'], data),
  });
  const status = statusQuery.data;
  const qrPayload = status?.qrPairingCode ?? null;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!qrPayload) {
      setQrDataUrl(null);
      return;
    }
    let stale = false;
    void toDataURL(qrPayload, { margin: 1, width: 200 }).then((url) => {
      if (!stale) {
        setQrDataUrl(url);
      }
    });
    return () => {
      stale = true;
    };
  }, [qrPayload]);
  const state = !status
    ? 'unknown'
    : !status.running
      ? 'stopped'
      : status.commissioned
        ? 'paired'
        : status.commissioned === false
          ? 'waiting to pair'
          : 'starting';

  return (
    <ChannelRow
      title="Apple Home / Google Home"
      on={state === 'paired'}
      status={state}
      hint="Shows AntiHunter as occupancy sensors in Apple/Google Home. Needs a home hub; scan the code to pair."
    >
      <div>
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={props.enabled}
            onChange={(event) => props.onEnabled(event.target.checked)}
          />
          <span>On</span>
        </label>
        <label className="form-field">
          <span>Layout</span>
          <select
            className="control-input"
            value={props.layout}
            onChange={(event) => props.onLayout(event.target.value as 'bridge' | 'flat')}
          >
            <option value="bridge">Named sensors</option>
            <option value="flat">Unnamed sensors (older pairings)</option>
          </select>
        </label>
        {status?.running && status.commissioned === false && qrDataUrl && (
          <div className="form-field">
            <img src={qrDataUrl} alt="Matter pairing QR code" width={200} height={200} />
            <p className="config-hint">Home app → + → Add Accessory → scan.</p>
          </div>
        )}
        {status?.running && status.commissioned === false && (
          <div className="form-grid">
            <label>
              <span>Setup code</span>
              <input className="control-input" readOnly value={status.manualPairingCode ?? ''} />
            </label>
            <label>
              <span>Passcode</span>
              <input className="control-input" readOnly value={status.passcode ?? ''} />
            </label>
          </div>
        )}
        {status?.lastExit && <p className="config-hint">Last exit: {status.lastExit}</p>}
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={props.busy}
            onClick={props.onSave}
          >
            Save
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={!status?.running || props.busy}
            onClick={props.onTest}
          >
            Test
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={restartMutation.isPending}
            onClick={() => restartMutation.mutate()}
          >
            Restart
          </button>
          <button
            type="button"
            className="control-chip control-chip--danger"
            disabled={!status?.running || eraseMutation.isPending}
            onClick={() => {
              if (window.confirm('Unpair from all homes?')) {
                eraseMutation.mutate();
              }
            }}
          >
            Reset pairing
          </button>
        </div>
        {props.notice && <p className="config-hint">{props.notice}</p>}
      </div>
    </ChannelRow>
  );
}
