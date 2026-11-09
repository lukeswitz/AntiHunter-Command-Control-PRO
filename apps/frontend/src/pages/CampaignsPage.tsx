import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { MdFlag } from 'react-icons/md';

import { CampaignDetail, CampaignSummary } from '../api/campaigns';
import { apiClient } from '../api/client';
import type { CommandRequest, CommandResponse } from '../api/types';
import {
  ClassFilter,
  ClassFilterBar,
  DeviceClassBadge,
  matchesClassFilter,
} from '../components/device-class';
import { useAuthStore } from '../stores/auth-store';
import { useNodeStore } from '../stores/node-store';

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,23}$/;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startIso: string, endIso: string | null): string {
  const ms = (endIso ? Date.parse(endIso) : Date.now()) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span className={`campaign-status${active ? ' is-active' : ''}`}>
      {active ? 'Active' : 'Ended'}
    </span>
  );
}

export function CampaignsPage() {
  const role = useAuthStore((state) => state.user?.role ?? null);
  const canSend = role === 'ADMIN' || role === 'OPERATOR';
  const isAdmin = role === 'ADMIN';
  const queryClient = useQueryClient();
  const nodes = useNodeStore((state) => state.nodes);

  const [name, setName] = useState('');
  const [target, setTarget] = useState('@ALL');
  const [feedback, setFeedback] = useState<{ level: 'ok' | 'error'; message: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [classFilter, setClassFilter] = useState<ClassFilter>('all');

  const targetOptions = useMemo(() => {
    const options = [{ value: '@ALL', label: 'All nodes' }];
    Object.values(nodes).forEach((node) => {
      const value = `@${node.id.toUpperCase()}`;
      options.push({ value, label: node.name ? `${node.name} (${value})` : value });
    });
    return options;
  }, [nodes]);

  const { data: campaigns, isLoading } = useQuery<CampaignSummary[]>({
    queryKey: ['campaigns'],
    queryFn: () => apiClient.get<CampaignSummary[]>('/campaigns'),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!selected && campaigns && campaigns.length > 0) {
      setSelected(campaigns[0].name);
    }
  }, [campaigns, selected]);

  const { data: detail } = useQuery<CampaignDetail>({
    queryKey: ['campaigns', selected],
    queryFn: () => apiClient.get<CampaignDetail>(`/campaigns/${encodeURIComponent(selected!)}`),
    enabled: Boolean(selected),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    setClassFilter('all');
  }, [selected]);

  const command = useMutation<CommandResponse, Error, CommandRequest>({
    mutationFn: (body) => apiClient.post<CommandResponse>('/commands/send', body),
    onSuccess: (_data, variables) => {
      setFeedback({ level: 'ok', message: `${variables.name} sent to ${variables.target}` });
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (error, variables) =>
      setFeedback({ level: 'error', message: `${variables.name}: ${error.message}` }),
  });

  const remove = useMutation({
    mutationFn: (campaign: string) =>
      apiClient.delete(`/campaigns/${encodeURIComponent(campaign)}`),
    onSuccess: () => {
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
  });

  const nameValid = NAME_PATTERN.test(name);
  const send = (cmd: string, params: string[] = []) => {
    if (!canSend) return;
    command.mutate({ target, name: cmd, params });
  };

  const devices = useMemo(
    () =>
      (detail?.deviceList ?? []).filter((d) => matchesClassFilter(d.classification, classFilter)),
    [detail, classFilter],
  );
  const watchCount = useMemo(
    () => (detail?.deviceList ?? []).filter((d) => d.classification?.watch).length,
    [detail],
  );

  return (
    <div className="page-stack campaigns-page">
      <header className="page-header">
        <h1 style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
          <MdFlag /> Campaigns
        </h1>
        <p className="form-hint">Named collection runs across nodes.</p>
      </header>

      <article className="config-card">
        <div className="campaign-run">
          <div className="baseline-field">
            <label className="form-label" htmlFor="campaign-name">
              Name
            </label>
            <input
              id="campaign-name"
              className="control-input"
              placeholder="site-a"
              maxLength={23}
              value={name}
              aria-invalid={name.length > 0 && !nameValid}
              onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))}
            />
          </div>
          <div className="baseline-field">
            <label className="form-label" htmlFor="campaign-target">
              Target
            </label>
            <select
              id="campaign-target"
              className="control-input"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targetOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="campaign-run__actions">
            <button
              type="button"
              className="control-chip control-chip--primary"
              disabled={!canSend || !nameValid || command.isPending}
              onClick={() => send('CAMPAIGN_START', [name])}
            >
              Start
            </button>
            <button
              type="button"
              className="control-chip control-chip--danger"
              disabled={!canSend || command.isPending}
              onClick={() => send('CAMPAIGN_STOP')}
            >
              Stop
            </button>
            <button
              type="button"
              className="control-chip"
              disabled={!canSend || command.isPending}
              onClick={() => send('CAMPAIGN_STATUS')}
            >
              Status
            </button>
          </div>
        </div>
        {feedback ? (
          <p className={`form-hint campaign-feedback campaign-feedback--${feedback.level}`}>
            {feedback.message}
          </p>
        ) : null}
        {!canSend ? <p className="form-hint">Read-only role.</p> : null}
      </article>

      <div className="campaign-layout">
        <article className="config-card campaign-list">
          <div className="panel__header">
            <h2 className="panel__title">Runs</h2>
          </div>
          {isLoading ? (
            <div className="empty-state">Loading…</div>
          ) : !campaigns || campaigns.length === 0 ? (
            <div className="empty-state">No campaigns yet.</div>
          ) : (
            <ul className="campaign-items">
              {campaigns.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    className={`campaign-item${selected === c.name ? ' is-selected' : ''}`}
                    aria-pressed={selected === c.name}
                    onClick={() => setSelected(c.name)}
                  >
                    <span className="campaign-item__top">
                      <span className="campaign-item__name">{c.name}</span>
                      <StatusPill active={c.active} />
                    </span>
                    <span className="campaign-item__meta">
                      {formatTime(c.startedAt)} · {formatDuration(c.startedAt, c.endedAt)} ·{' '}
                      {c.nodes.length} node{c.nodes.length === 1 ? '' : 's'} · {c.devices} devices
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="config-card campaign-detail">
          {!detail ? (
            <div className="empty-state">Select a campaign.</div>
          ) : (
            <>
              <div className="campaign-detail__head">
                <h2 className="panel__title">{detail.name}</h2>
                <StatusPill active={detail.active} />
                {isAdmin ? (
                  <button
                    type="button"
                    className="control-chip control-chip--ghost campaign-detail__delete"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete campaign ${detail.name}?`)) {
                        remove.mutate(detail.name);
                      }
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </div>

              <dl className="campaign-stats">
                <div>
                  <dt>Devices</dt>
                  <dd>{detail.devices}</dd>
                </div>
                <div>
                  <dt>Watch</dt>
                  <dd className={watchCount > 0 ? 'is-watch' : undefined}>{watchCount}</dd>
                </div>
                <div>
                  <dt>Nodes</dt>
                  <dd>{detail.nodes.length}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{formatDuration(detail.startedAt, detail.endedAt)}</dd>
                </div>
              </dl>

              <div className="campaign-runs">
                {detail.runs.map((run) => (
                  <span key={`${run.nodeId}-${run.startedAt}`} className="campaign-run-chip">
                    <strong>{run.nodeId}</strong>
                    {formatTime(run.startedAt)} → {run.endedAt ? formatTime(run.endedAt) : 'now'}
                  </span>
                ))}
              </div>

              <ClassFilterBar
                items={detail.deviceList.map((d) => d.classification)}
                value={classFilter}
                onChange={setClassFilter}
              />

              {detail.deviceList.length === 0 ? (
                <div className="empty-state">No devices recorded in this window.</div>
              ) : (
                <div className="inventory-table inventory-table--cards">
                  <table>
                    <thead>
                      <tr>
                        <th>MAC</th>
                        <th>Class</th>
                        <th>Vendor</th>
                        <th>Name</th>
                        <th>Hits</th>
                        <th>Best RSSI</th>
                        <th>Last seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {devices.map((d) => (
                        <tr key={d.mac}>
                          <td data-label="MAC" data-span="half" className="inventory-mac">
                            {d.mac}
                          </td>
                          <td data-label="Class" data-span="half">
                            <DeviceClassBadge classification={d.classification} />
                          </td>
                          <td data-label="Vendor">{d.vendor ?? '—'}</td>
                          <td data-label="Name">{d.ssid ?? '—'}</td>
                          <td data-label="Hits">{d.hits}</td>
                          <td data-label="Best RSSI">{d.maxRSSI ?? '—'}</td>
                          <td data-label="Last seen">{formatTime(d.lastSeen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {devices.length === 0 ? (
                    <div className="empty-state">No devices in this class.</div>
                  ) : null}
                </div>
              )}
            </>
          )}
        </article>
      </div>
    </div>
  );
}
