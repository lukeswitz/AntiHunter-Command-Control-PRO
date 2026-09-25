import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  getFleetChannels,
  getFleetIdentities,
  getFleetIdentity,
  getFleetPolicy,
  getFleetTrust,
  refreshFleetChannels,
  registerFleetIdentity,
  revokeFleetIdentity,
  setFleetIsManaged,
  setFleetPolicy,
  startRotation,
  verifyFleetNode,
} from '../api/fleet-security';
import { useAuthStore } from '../stores/auth-store';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function FleetSecurityPage() {
  const role = useAuthStore((state) => state.user?.role);
  const isAdmin = role === 'ADMIN';
  const canOperate = isAdmin || role === 'OPERATOR';
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const identity = useQuery({
    queryKey: ['fleet-identity'],
    queryFn: getFleetIdentity,
    retry: false,
  });
  const identities = useQuery({ queryKey: ['fleet-identities'], queryFn: getFleetIdentities });
  const trust = useQuery({ queryKey: ['fleet-trust'], queryFn: getFleetTrust });
  const channels = useQuery({ queryKey: ['fleet-channels'], queryFn: getFleetChannels });
  const policy = useQuery({ queryKey: ['fleet-policy'], queryFn: getFleetPolicy });

  const [regLabel, setRegLabel] = useState('');
  const [regKey, setRegKey] = useState('');
  const [rotateTargets, setRotateTargets] = useState('');

  const ok = (text: string) => setNotice({ ok: true, text });
  const fail = (error: unknown) => setNotice({ ok: false, text: errorText(error) });
  const refresh = (key: string) => queryClient.invalidateQueries({ queryKey: [key] });

  const register = useMutation({
    mutationFn: () =>
      registerFleetIdentity({ label: regLabel.trim(), publicKey: regKey.trim(), role: 'operator' }),
    onSuccess: () => {
      ok('Identity registered.');
      setRegLabel('');
      setRegKey('');
      refresh('fleet-identities');
    },
    onError: fail,
  });
  const revoke = useMutation({
    mutationFn: (fp: string) => revokeFleetIdentity(fp, 'revoked from console'),
    onSuccess: () => {
      ok('Identity revoked.');
      refresh('fleet-identities');
    },
    onError: fail,
  });
  const verify = useMutation({
    mutationFn: (nodeNum: number) => verifyFleetNode(nodeNum),
    onSuccess: (res) => {
      setNotice(
        res.ok
          ? { ok: true, text: 'Node verified.' }
          : { ok: false, text: res.error ?? 'Verify failed.' },
      );
      refresh('fleet-trust');
    },
    onError: fail,
  });
  const managed = useMutation({
    mutationFn: ({ nodeNum, value }: { nodeNum: number; value: boolean }) =>
      setFleetIsManaged(nodeNum, value),
    onSuccess: () => {
      ok('Managed flag sent.');
      refresh('fleet-trust');
    },
    onError: fail,
  });
  const refreshCh = useMutation({
    mutationFn: refreshFleetChannels,
    onSuccess: () => {
      ok('Channels re-read from the radio.');
      refresh('fleet-channels');
    },
    onError: fail,
  });
  const policyMut = useMutation({
    mutationFn: (value: boolean) => setFleetPolicy({ expectedIsManaged: value }),
    onSuccess: () => {
      ok('Policy saved.');
      refresh('fleet-policy');
    },
    onError: fail,
  });
  const rotate = useMutation({
    mutationFn: () =>
      startRotation({
        channelIndex: 0,
        targets: rotateTargets
          .split(/[\s,]+/)
          .map((t) => Number(t))
          .filter((n) => Number.isFinite(n) && n > 0),
        ack: 'ROTATE',
      }),
    onSuccess: (res) => {
      ok(`Rotation ${res.rotationId.slice(0, 8)} started (new PSK ${res.newPskFingerprint}).`);
      setRotateTargets('');
      refresh('fleet-trust');
    },
    onError: fail,
  });

  return (
    <div className="page">
      <header className="page-header">
        <h1>Fleet Security</h1>
        <p>Radio identity, per-node trust, and channel key rotation across the mesh.</p>
      </header>

      {notice ? (
        <p className={notice.ok ? 'config-hint' : 'config-hint config-hint--warn'}>{notice.text}</p>
      ) : null}

      <section className="config-card">
        <header>
          <h2>Identity</h2>
          <p>The control-post radio key, and the operator keys it trusts.</p>
        </header>
        <div className="config-card__body">
          {identity.isError ? (
            <p className="config-hint config-hint--warn">{errorText(identity.error)}</p>
          ) : identity.data ? (
            <div className="config-row">
              <span className="config-label">This radio</span>
              <span>
                {identity.data.label ?? 'unregistered'} · <code>{identity.data.fingerprint}</code>
              </span>
            </div>
          ) : (
            <p className="config-hint">Loading.</p>
          )}
          <table className="data-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Fingerprint</th>
                <th>Role</th>
                {isAdmin ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {(identities.data ?? []).map((i) => (
                <tr key={i.id}>
                  <td>{i.label}</td>
                  <td>
                    <code>{i.fingerprint}</code>
                  </td>
                  <td>{i.role}</td>
                  {isAdmin ? (
                    <td>
                      {i.role !== 'revoked' ? (
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => revoke.mutate(i.fingerprint)}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin ? (
            <div className="controls-row">
              <input
                className="control-input"
                placeholder="Operator label"
                value={regLabel}
                onChange={(e) => setRegLabel(e.target.value)}
              />
              <input
                className="control-input"
                placeholder="Public key (base64)"
                value={regKey}
                onChange={(e) => setRegKey(e.target.value)}
              />
              <button
                type="button"
                className="control-chip"
                disabled={register.isPending || !regLabel.trim() || !regKey.trim()}
                onClick={() => register.mutate()}
              >
                Add operator key
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="config-card">
        <header>
          <h2>Trust roster</h2>
          <p>Which admin keys each node accepts, and whether it is locked to remote admin.</p>
        </header>
        <div className="config-card__body">
          <table className="data-table">
            <thead>
              <tr>
                <th>Node</th>
                <th>Drift</th>
                <th>Managed</th>
                <th>Last verified</th>
                {canOperate ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {(trust.data ?? []).map((n) => (
                <tr key={n.nodeNum}>
                  <td>{n.name}</td>
                  <td>{n.driftStatus}</td>
                  <td>{n.isManaged ? 'yes' : 'no'}</td>
                  <td>
                    {n.lastVerifiedAt ? new Date(n.lastVerifiedAt).toLocaleString() : 'never'}
                  </td>
                  {canOperate ? (
                    <td className="controls-row">
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => verify.mutate(n.nodeNum)}
                      >
                        Verify
                      </button>
                      {isAdmin ? (
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() =>
                            managed.mutate({ nodeNum: n.nodeNum, value: !n.isManaged })
                          }
                        >
                          {n.isManaged ? 'Unmanage' : 'Manage'}
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
              {(trust.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5}>No nodes verified yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="config-card">
        <header>
          <h2>Channels &amp; key rotation</h2>
          <p>Rotate the mesh PSK in stages so nodes stay reachable throughout.</p>
        </header>
        <div className="config-card__body">
          {canOperate ? (
            <button
              type="button"
              className="control-chip"
              disabled={refreshCh.isPending}
              onClick={() => refreshCh.mutate()}
            >
              Read channels from radio
            </button>
          ) : null}
          <table className="data-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Role</th>
                <th>Name</th>
                <th>PSK fingerprint</th>
              </tr>
            </thead>
            <tbody>
              {(channels.data ?? []).map((c) => (
                <tr key={c.channelIndex}>
                  <td>{c.channelIndex}</td>
                  <td>{c.role}</td>
                  <td>{c.name || '—'}</td>
                  <td>{c.pskFingerprint ? <code>{c.pskFingerprint}</code> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin ? (
            <div className="controls-row">
              <input
                className="control-input"
                placeholder="Target node numbers (comma separated)"
                value={rotateTargets}
                onChange={(e) => setRotateTargets(e.target.value)}
              />
              <button
                type="button"
                className="control-chip"
                disabled={rotate.isPending || !rotateTargets.trim()}
                onClick={() => {
                  if (window.confirm('Rotate the mesh PSK for these nodes?')) {
                    rotate.mutate();
                  }
                }}
              >
                Rotate PSK
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="config-card">
        <header>
          <h2>Policy</h2>
          <p>Expected fleet posture; drift shows in the roster.</p>
        </header>
        <div className="config-card__body">
          <label className="checkbox-label">
            <input
              type="checkbox"
              disabled={!isAdmin || policyMut.isPending}
              checked={policy.data?.expectedIsManaged ?? false}
              onChange={(e) => policyMut.mutate(e.target.checked)}
            />
            Expect every node to be managed (remote-admin only)
          </label>
        </div>
      </section>
    </div>
  );
}
