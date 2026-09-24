import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toDataURL } from 'qrcode';
import { useEffect, useState } from 'react';

import { PushNotificationsCard } from './WebhooksSection';
import { listAlertRules } from '../api/alert-rules';
import {
  AlertChannel,
  AlertTier,
  clearRemoteAlertSecret,
  eraseMatter,
  generateVapidKeys,
  getMatterStatus,
  getRemoteAlertConfig,
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
    <div className="config-grid webhooks-stack">
      <PushNotificationsCard />
      {isAdmin ? (
        <AdminCards />
      ) : (
        <article className="config-card">
          <div className="config-card__body">
            <p className="empty-state">Only administrators can change remote access and alerts.</p>
          </div>
        </article>
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
      <article className="config-card">
        <div className="config-card__body">
          <p className="empty-state">
            {configQuery.error ? errorText(configQuery.error) : 'Loading settings...'}
          </p>
        </div>
      </article>
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
      <article className="config-card">
        <header>
          <h3>Remote access (Tailscale)</h3>
          <p>
            Tailnet users listed here can reach the login page through the Tailscale entrance. An
            empty list blocks everyone. Your normal login and 2FA still apply.
          </p>
        </header>
        <div className="config-card__body">
          <label className="form-field">
            <span>Allowed Tailscale logins (one per line)</span>
            <textarea
              className="control-input"
              rows={4}
              value={form.tsAllowedLogins}
              placeholder="you@example.com"
              onChange={(event) => set('tsAllowedLogins', event.target.value)}
            />
          </label>
          <p className="config-hint">
            Start the entrance with <code>docker compose --profile remote up -d</code> after setting
            TS_AUTHKEY (a tagged tag:ahcc key) in .env. Funnel stays off.
          </p>
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
        </div>
      </article>

      <AlertLevelsCard
        tiers={config.alertTiers ?? {}}
        busy={busy}
        onSave={(alertTiers) => save('levels', { alertTiers })}
        notice={notice.levels}
      />

      <PushAdminCard
        config={config}
        subject={form.vapidSubject}
        onSubject={(value) => set('vapidSubject', value)}
        onSaveSubject={() => save('push', { vapidSubject: form.vapidSubject })}
        onTest={() => testMutation.mutate('push')}
        busy={busy}
        notice={notice.push}
      />

      <article className="config-card">
        <header>
          <h3>Signal</h3>
          <p>End-to-end encrypted. Needs the signal-api container linked to your Signal account.</p>
        </header>
        <div className="config-card__body">
          <label className="control-checkbox">
            <input
              type="checkbox"
              checked={form.signalEnabled}
              onChange={(event) => set('signalEnabled', event.target.checked)}
            />
            <span>Send alerts to Signal</span>
          </label>
          <div className="form-grid">
            <label>
              <span>Signal API URL</span>
              <input
                className="control-input"
                value={form.signalApiUrl}
                placeholder="http://signal-api:8080"
                onChange={(event) => set('signalApiUrl', event.target.value)}
              />
            </label>
            <label>
              <span>Sending number (linked account)</span>
              <input
                className="control-input"
                value={form.signalNumber}
                placeholder="+15551234567"
                onChange={(event) => set('signalNumber', event.target.value)}
              />
            </label>
          </div>
          <label className="form-field">
            <span>Recipients (one per line)</span>
            <textarea
              className="control-input"
              rows={3}
              value={form.signalRecipients}
              onChange={(event) => set('signalRecipients', event.target.value)}
            />
          </label>
          <p className="config-hint">
            Link once: run{' '}
            <code>docker compose --profile signal run --rm -p 127.0.0.1:8090:8080 signal-api</code>,
            open http://127.0.0.1:8090/v1/qrcodelink?device_name=ahcc, scan it from Signal &gt;
            Settings &gt; Linked devices, stop it, then{' '}
            <code>docker compose --profile signal up -d</code>. The API has no password, so it is
            never published.
          </p>
          <div className="controls-row">
            <button
              type="button"
              className="control-chip"
              disabled={busy}
              onClick={() =>
                save('signal', {
                  signalEnabled: form.signalEnabled,
                  signalApiUrl: form.signalApiUrl,
                  signalNumber: form.signalNumber,
                  signalRecipients: lines(form.signalRecipients),
                })
              }
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
        </div>
      </article>

      <article className="config-card">
        <header>
          <h3>ntfy</h3>
          <p>The ntfy server can read every alert. Use your own server and an access token.</p>
        </header>
        <div className="config-card__body">
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
        </div>
      </article>

      <article className="config-card">
        <header>
          <h3>Matrix</h3>
          <p>Messages are not end-to-end encrypted. Use your own homeserver.</p>
        </header>
        <div className="config-card__body">
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
        </div>
      </article>

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
    </>
  );
}

const NODE_SOURCES: Array<{ key: string; label: string }> = [
  { key: 'node:attack', label: 'Node: deauth / disassoc attack' },
  { key: 'node:tamper', label: 'Node: tamper' },
  { key: 'node:erase', label: 'Node: erase' },
  { key: 'node:vibration', label: 'Node: vibration' },
  { key: 'node:mesh-guard', label: 'Node: mesh guard' },
  { key: 'node:other', label: 'Node: other ALERT-level events' },
  { key: 'mqtt', label: 'Alerts from linked MQTT sites' },
];

function AlertLevelsCard(props: {
  tiers: Record<string, AlertTier>;
  busy: boolean;
  onSave: (tiers: Record<string, AlertTier>) => void;
  notice?: string;
}) {
  const rulesQuery = useQuery({
    queryKey: ['alert-rules', 'all'],
    queryFn: () => listAlertRules({ includeAll: true, includeInactive: true }),
  });
  const [draft, setDraft] = useState<Record<string, AlertTier>>(props.tiers);
  useEffect(() => setDraft(props.tiers), [props.tiers]);

  const sources = [
    ...(rulesQuery.data ?? []).map((rule) => ({
      key: `rule:${rule.id}`,
      label: `Rule: ${rule.name}${rule.isActive ? '' : ' (inactive)'}`,
    })),
    ...NODE_SOURCES,
  ];

  return (
    <article className="config-card">
      <header>
        <h3>What counts as Alert or Critical</h3>
        <p>
          Choose how each detection source reaches your phone and Home. <strong>Alert</strong> sends
          the message and turns on the AntiHunter Alert sensor. <strong>Critical</strong> also turns
          on the AntiHunter Critical sensor and marks the message critical. <strong>Off</strong>{' '}
          sends nothing (webhooks and email are unchanged). New sources start as Alert.
        </p>
      </header>
      <div className="config-card__body">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Level</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.key}>
                  <td>{source.label}</td>
                  <td>
                    <select
                      className="control-input"
                      value={draft[source.key] ?? 'alert'}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          [source.key]: event.target.value as AlertTier,
                        }))
                      }
                    >
                      <option value="off">Off</option>
                      <option value="alert">Alert</option>
                      <option value="critical">Critical</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
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
    </article>
  );
}

function PushAdminCard(props: {
  config: RemoteAlertConfig;
  subject: string;
  onSubject: (value: string) => void;
  onSaveSubject: () => void;
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
    <article className="config-card">
      <header>
        <h3>Phone push notifications</h3>
        <p>
          End-to-end encrypted to each phone or browser. Status:{' '}
          <strong>{configured ? 'configured' : 'not configured'}</strong>
        </p>
      </header>
      <div className="config-card__body">
        <div className="controls-row">
          <button
            type="button"
            className={configured ? 'control-chip control-chip--danger' : 'control-chip'}
            disabled={generateMutation.isPending}
            onClick={() => {
              if (
                !configured ||
                window.confirm(
                  'New keys sign out every subscribed device; each one must press Enable again. Continue?',
                )
              ) {
                generateMutation.mutate();
              }
            }}
          >
            {configured ? 'Replace keys' : 'Generate keys'}
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={!configured || props.busy}
            onClick={props.onTest}
          >
            Send test to all devices
          </button>
        </div>
        {generateMutation.error && (
          <p className="config-hint">{errorText(generateMutation.error)}</p>
        )}
        <label className="form-field">
          <span>Contact (sent to push services with each message)</span>
          <input
            className="control-input"
            value={props.subject}
            placeholder="mailto:admin@example.com"
            onChange={(event) => props.onSubject(event.target.value)}
          />
        </label>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={props.busy}
            onClick={props.onSaveSubject}
          >
            Save contact
          </button>
        </div>
        {props.notice && <p className="config-hint">{props.notice}</p>}
        <h4>Subscribed devices</h4>
        {subsQuery.data && subsQuery.data.length > 0 ? (
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
        ) : (
          <p className="empty-state">No devices subscribed.</p>
        )}
      </div>
    </article>
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
    <article className="config-card">
      <header>
        <h3>Apple Home / Google Home (Matter)</h3>
        <p>
          AntiHunter appears as occupancy sensors: one for any alert, one for critical alerts. Needs
          a home hub (HomePod, Apple TV or Nest). State: <strong>{state}</strong>
        </p>
      </header>
      <div className="config-card__body">
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={props.enabled}
            onChange={(event) => props.onEnabled(event.target.checked)}
          />
          <span>Run the Matter device</span>
        </label>
        <label className="form-field">
          <span>Layout</span>
          <select
            className="control-input"
            value={props.layout}
            onChange={(event) => props.onLayout(event.target.value as 'bridge' | 'flat')}
          >
            <option value="bridge">Bridge with named sensors (new pairings)</option>
            <option value="flat">Two unnamed sensors (pairings made before the bridge)</option>
          </select>
        </label>
        <p className="config-hint">
          Changing the layout changes how Home sees the device. Remove AntiHunter from Home and pair
          again after switching.
        </p>
        {status?.running && status.commissioned === false && qrDataUrl && (
          <div className="form-field">
            <img src={qrDataUrl} alt="Matter pairing QR code" width={200} height={200} />
            <p className="config-hint">
              iPhone: Home app → + → Add Accessory, point the camera here. Android: Google Home →
              Devices → Add → Matter-enabled device, scan. Or type the setup code below.
            </p>
          </div>
        )}
        {status?.running && status.commissioned === false && (
          <div className="form-grid">
            <label>
              <span>Setup code</span>
              <input className="control-input" readOnly value={status.manualPairingCode ?? ''} />
            </label>
            <label>
              <span>8-digit passcode</span>
              <input className="control-input" readOnly value={status.passcode ?? ''} />
            </label>
          </div>
        )}
        <p className="config-hint">
          Runs as {status?.runtime ?? '...'}. On macOS, allow only the signed ahcc-matter app in the
          firewall, never node.
          {status?.lastExit ? ` Last exit: ${status.lastExit}.` : ''}
        </p>
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
            Test (both sensors on)
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
              if (
                window.confirm(
                  'Reset pairing removes AntiHunter from every connected home and shows a new setup code. Continue?',
                )
              ) {
                eraseMutation.mutate();
              }
            }}
          >
            Reset pairing
          </button>
        </div>
        {props.notice && <p className="config-hint">{props.notice}</p>}
      </div>
    </article>
  );
}
