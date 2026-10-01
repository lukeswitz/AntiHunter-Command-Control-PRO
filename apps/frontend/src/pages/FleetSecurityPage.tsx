import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  getFleetChannels,
  getFleetIdentity,
  getFleetPubkey,
  getFleetTrust,
  refreshFleetChannels,
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
  const pubkey = useQuery({ queryKey: ['fleet-pubkey'], queryFn: getFleetPubkey, retry: false });
  const trust = useQuery({ queryKey: ['fleet-trust'], queryFn: getFleetTrust });
  const channels = useQuery({ queryKey: ['fleet-channels'], queryFn: getFleetChannels });

  const [rotateTargets, setRotateTargets] = useState<number[]>([]);

  const ok = (text: string) => setNotice({ ok: true, text });
  const fail = (error: unknown) => setNotice({ ok: false, text: errorText(error) });
  const refresh = (key: string) => queryClient.invalidateQueries({ queryKey: [key] });

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
  const refreshCh = useMutation({
    mutationFn: refreshFleetChannels,
    onSuccess: () => {
      ok('Channels re-read from the radio.');
      refresh('fleet-channels');
    },
    onError: fail,
  });
  const rotate = useMutation({
    mutationFn: () =>
      startRotation({
        channelIndex: 0,
        targets: rotateTargets,
        ack: 'ROTATE',
      }),
    onSuccess: (res) => {
      ok(`Rotation ${res.rotationId.slice(0, 8)} started (new PSK ${res.newPskFingerprint}).`);
      setRotateTargets([]);
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
          <h2>This radio&apos;s admin key</h2>
          <p>Paste into each node&apos;s Admin Key (Meshtastic app, Security).</p>
        </header>
        <div className="config-card__body">
          {pubkey.isError ? (
            <p className="config-hint config-hint--warn">{errorText(pubkey.error)}</p>
          ) : pubkey.data ? (
            <div className="controls-row">
              <code>{pubkey.data.publicKey}</code>
              <button
                type="button"
                className="control-chip"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(pubkey.data.publicKey)
                    .then(() => ok('Admin key copied.'), fail);
                }}
              >
                Copy
              </button>
            </div>
          ) : (
            <p className="config-hint">Loading.</p>
          )}
        </div>
      </section>

      <section className="config-card">
        <header>
          <h2>Nodes</h2>
          <p>Verify reads each node&apos;s admin keys over the mesh.</p>
        </header>
        <div className="config-card__body">
          <table className="data-table">
            <thead>
              <tr>
                {isAdmin ? <th aria-label="Select for rotation" /> : null}
                <th>Node</th>
                <th>Accepts this radio</th>
                <th>Managed</th>
                <th>Last verified</th>
                {canOperate ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {(trust.data ?? []).map((n) => (
                <tr key={n.nodeNum}>
                  {isAdmin ? (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${n.name} for rotation`}
                        checked={rotateTargets.includes(n.nodeNum)}
                        onChange={(e) =>
                          setRotateTargets((prev) =>
                            e.target.checked
                              ? [...prev, n.nodeNum]
                              : prev.filter((x) => x !== n.nodeNum),
                          )
                        }
                      />
                    </td>
                  ) : null}
                  <td>{n.name}</td>
                  <td>
                    {n.driftStatus === 'unreachable'
                      ? 'unreachable'
                      : !n.lastVerifiedAt
                        ? 'not verified'
                        : identity.data &&
                            n.adminKeyFingerprints.includes(identity.data.fingerprint)
                          ? 'yes'
                          : 'no'}
                  </td>
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
                    </td>
                  ) : null}
                </tr>
              ))}
              {(trust.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6}>No mesh nodes seen by the radio yet.</td>
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
            <div className="controls-row">
              <button
                type="button"
                className="control-chip"
                disabled={refreshCh.isPending}
                onClick={() => refreshCh.mutate()}
              >
                Read channels from radio
              </button>
            </div>
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
              {(channels.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4}>Not read yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          {isAdmin ? (
            <div className="controls-row">
              <span className="config-hint">
                {rotateTargets.length === 0
                  ? 'Tick nodes in the list above to rotate.'
                  : `${rotateTargets.length} node${rotateTargets.length === 1 ? '' : 's'} selected.`}
              </span>
              <button
                type="button"
                className="control-chip"
                disabled={rotate.isPending || rotateTargets.length === 0}
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
    </div>
  );
}
