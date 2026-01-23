import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiClient } from '../api/client';
import type { CommandRequest } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { useMapCommandStore } from '../stores/map-command-store';
import { useNodeStore } from '../stores/node-store';

const ONLINE_THRESHOLD_MS = 11 * 60 * 1000;

async function sendCommand(body: CommandRequest): Promise<void> {
  await apiClient.post('/commands/send', body);
}

function normalizeNodeTarget(nodeId: string): string {
  const trimmed = nodeId.trim().toUpperCase();
  if (/^NODE_AH\d+$/.test(trimmed)) {
    return `@${trimmed.replace(/^NODE_/, '')}`;
  }
  if (/^AH\d+$/.test(trimmed)) {
    return `@${trimmed}`;
  }
  return `@${trimmed.replace(/^NODE_/, '').replace(/^@/, '')}`;
}

function BatteryIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1" y="6" width="18" height="12" rx="2" ry="2" />
      <line x1="23" y1="13" x2="23" y2="11" />
      <line x1="6" y1="10" x2="6" y2="14" />
      <line x1="10" y1="10" x2="10" y2="14" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

interface BatterySaverDialogProps {
  nodeId: string;
  nodeName: string;
  siteId?: string;
  onClose: () => void;
}

function BatterySaverDialog({ nodeId, nodeName, siteId, onClose }: BatterySaverDialogProps) {
  const [interval, setIntervalValue] = useState(5);
  const [loading, setLoading] = useState<'start' | 'stop' | 'status' | null>(null);
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const target = normalizeNodeTarget(nodeId);

  const handleStart = async () => {
    setLoading('start');
    setResult(null);
    try {
      await sendCommand({
        target,
        name: 'BATTERY_SAVER_START',
        params: [String(interval)],
        siteId,
      });
      setResult({
        type: 'success',
        message: `Battery saver enabled with ${interval} minute heartbeat interval`,
      });
    } catch (err) {
      setResult({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to start battery saver',
      });
    } finally {
      setLoading(null);
    }
  };

  const handleStop = async () => {
    setLoading('stop');
    setResult(null);
    try {
      await sendCommand({
        target,
        name: 'BATTERY_SAVER_STOP',
        params: [],
        siteId,
      });
      setResult({
        type: 'success',
        message: 'Battery saver disabled - node returning to normal operation',
      });
    } catch (err) {
      setResult({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to stop battery saver',
      });
    } finally {
      setLoading(null);
    }
  };

  const handleStatus = async () => {
    setLoading('status');
    setResult(null);
    try {
      await sendCommand({
        target,
        name: 'BATTERY_SAVER_STATUS',
        params: [],
        siteId,
      });
      setResult({
        type: 'success',
        message: 'Status request sent - response will appear in terminal',
      });
    } catch (err) {
      setResult({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to request status',
      });
    } finally {
      setLoading(null);
    }
  };

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      role="presentation"
    >
      <div
        className="modal-content battery-saver-dialog"
        role="dialog"
        aria-labelledby="battery-saver-dialog-title"
        aria-modal="true"
      >
        <div className="battery-saver-dialog__header">
          <BatteryIcon className="battery-saver-dialog__header-icon" />
          <div>
            <h3 id="battery-saver-dialog-title">Battery Saver Mode</h3>
            <p className="battery-saver-dialog__target">
              Node: <strong>{nodeName}</strong> ({target})
            </p>
          </div>
        </div>

        <div className="battery-saver-dialog__info">
          <p>
            Battery saver mode reduces power consumption by disabling WiFi/BLE scanning, lowering
            CPU frequency to 80MHz, and enabling light sleep between heartbeats.
          </p>
        </div>

        <div className="battery-saver-dialog__section">
          <label htmlFor="battery-interval" className="battery-saver-dialog__label">
            Heartbeat Interval
          </label>
          <div className="battery-saver-dialog__interval-row">
            <input
              id="battery-interval"
              type="range"
              min={1}
              max={30}
              value={interval}
              onChange={(e) => setIntervalValue(Number(e.target.value))}
              className="battery-saver-dialog__slider"
            />
            <span className="battery-saver-dialog__interval-display">{interval} min</span>
          </div>
          <small className="battery-saver-dialog__hint">
            Lower interval = more frequent updates but higher power usage (1-30 minutes)
          </small>
        </div>

        {result && (
          <div
            className={`battery-saver-dialog__result battery-saver-dialog__result--${result.type}`}
          >
            {result.message}
          </div>
        )}

        <div className="battery-saver-dialog__actions">
          <button
            type="button"
            className="battery-saver-dialog__btn battery-saver-dialog__btn--start"
            onClick={handleStart}
            disabled={loading !== null}
          >
            <PlayIcon />
            {loading === 'start' ? 'Enabling...' : 'Enable'}
          </button>
          <button
            type="button"
            className="battery-saver-dialog__btn battery-saver-dialog__btn--stop"
            onClick={handleStop}
            disabled={loading !== null}
          >
            <StopIcon />
            {loading === 'stop' ? 'Disabling...' : 'Disable'}
          </button>
          <button
            type="button"
            className="battery-saver-dialog__btn battery-saver-dialog__btn--status"
            onClick={handleStatus}
            disabled={loading !== null}
          >
            <InfoIcon />
            {loading === 'status' ? 'Checking...' : 'Check Status'}
          </button>
        </div>

        <div className="battery-saver-dialog__footer">
          <button type="button" className="control-chip" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

type NodeSortKey =
  | 'node'
  | 'status'
  | 'site'
  | 'lastSeen'
  | 'location'
  | 'temperature'
  | 'lastMessage';
type SortDirection = 'asc' | 'desc';

export function NodesPage() {
  const nodes = useNodeStore((state) => state.nodes);
  const order = useNodeStore((state) => state.order);
  const clearNodes = useNodeStore((state) => state.clearAll);
  const gotoOnMap = useMapCommandStore((state) => state.goto);
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<NodeSortKey>('lastSeen');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [search, setSearch] = useState('');
  const [batterySaverDialog, setBatterySaverDialog] = useState<{
    nodeId: string;
    nodeName: string;
    siteId?: string;
  } | null>(null);
  const role = useAuthStore((state) => state.user?.role ?? null);
  const canSendCommands = role === 'ADMIN' || role === 'OPERATOR';

  const baseRows = useMemo(() => {
    return order
      .map((id) => nodes[id])
      .filter(Boolean)
      .map((node) => buildRow(node));
  }, [nodes, order]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      return baseRows;
    }
    return baseRows.filter((row) => {
      return (
        row.displayName.toLowerCase().includes(term) ||
        row.nodeId.toLowerCase().includes(term) ||
        (row.siteLabel?.toLowerCase().includes(term) ?? false) ||
        (row.lastMessage?.toLowerCase().includes(term) ?? false) ||
        (row.location?.toLowerCase().includes(term) ?? false)
      );
    });
  }, [baseRows, search]);

  const rows = useMemo(
    () => sortRows(filteredRows, sortKey, sortDirection),
    [filteredRows, sortKey, sortDirection],
  );

  const handleGoto = useCallback(
    (row: NodeRow) => {
      if (typeof row.lat !== 'number' || typeof row.lon !== 'number') {
        return;
      }
      gotoOnMap({
        lat: row.lat,
        lon: row.lon,
        zoom: 15,
        nodeId: row.nodeId,
      });
      navigate('/map');
    },
    [gotoOnMap, navigate],
  );

  const handleSort = useCallback(
    (column: NodeSortKey) => {
      if (sortKey === column) {
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(column);
        setSortDirection(getDefaultDirection(column));
      }
    },
    [sortKey],
  );

  const ariaSort = useCallback(
    (column: NodeSortKey): 'none' | 'ascending' | 'descending' =>
      sortKey === column ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
    [sortDirection, sortKey],
  );

  const renderSortIcon = useCallback(
    (column: NodeSortKey) => {
      if (sortKey !== column) {
        return (
          <span className="table-sort__icon" aria-hidden="true">
            ↕
          </span>
        );
      }
      return (
        <span className="table-sort__icon" aria-hidden="true">
          {sortDirection === 'asc' ? '↑' : '↓'}
        </span>
      );
    },
    [sortDirection, sortKey],
  );

  const handleClearNodes = useCallback(async () => {
    if (!window.confirm('Clear all nodes from the system? Historical telemetry will be removed.')) {
      return;
    }
    try {
      await apiClient.delete('/nodes');
      clearNodes();
    } catch (error) {
      console.error('Failed to clear nodes', error);
      window.alert('Unable to clear nodes. Check backend logs and try again.');
    }
  }, [clearNodes]);

  const openBatterySaverDialog = useCallback(
    (row: NodeRow) => {
      if (!canSendCommands) {
        window.alert('You need OPERATOR or ADMIN privileges to control battery saver.');
        return;
      }
      if (!row.online) {
        window.alert('Cannot control battery saver on offline nodes.');
        return;
      }
      setBatterySaverDialog({
        nodeId: row.nodeId,
        nodeName: row.displayName,
        siteId: row.siteId,
      });
    },
    [canSendCommands],
  );

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Nodes</h1>
          <p className="panel__subtitle">
            Health snapshots for every mesh node: connectivity state, last telemetry, and location.
          </p>
        </div>
        <div className="controls-row">
          <input
            className="control-input"
            placeholder="Search node, site, or message"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="button" className="control-chip" onClick={handleClearNodes}>
            Clear Nodes
          </button>
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="empty-state">
          <div>No nodes discovered yet. Connect a serial feed to populate live node telemetry.</div>
        </div>
      ) : (
        <div className="nodes-table">
          <table>
            <thead>
              <tr>
                <th aria-sort={ariaSort('node')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('node')}>
                    Node {renderSortIcon('node')}
                  </button>
                </th>
                <th aria-sort={ariaSort('status')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('status')}>
                    Status {renderSortIcon('status')}
                  </button>
                </th>
                <th aria-sort={ariaSort('site')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('site')}>
                    Site {renderSortIcon('site')}
                  </button>
                </th>
                <th aria-sort={ariaSort('lastSeen')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('lastSeen')}
                  >
                    Last Seen {renderSortIcon('lastSeen')}
                  </button>
                </th>
                <th aria-sort={ariaSort('location')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('location')}
                  >
                    Location {renderSortIcon('location')}
                  </button>
                </th>
                <th aria-sort={ariaSort('temperature')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('temperature')}
                  >
                    Temperature {renderSortIcon('temperature')}
                  </button>
                </th>
                <th aria-sort={ariaSort('lastMessage')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('lastMessage')}
                  >
                    Last Message {renderSortIcon('lastMessage')}
                  </button>
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <div className="node-cell">
                      <strong>{row.displayName}</strong>
                      <span className="node-id">{row.nodeId}</span>
                    </div>
                  </td>
                  <td>
                    <span
                      className={`status-badge ${row.online ? 'status-online' : 'status-offline'}`}
                    >
                      {row.online ? 'Online' : 'Offline'}
                    </span>
                  </td>
                  <td>
                    {row.siteLabel ? (
                      <span
                        className="site-chip"
                        style={
                          row.siteColor ? { background: row.siteColor, color: '#fff' } : undefined
                        }
                      >
                        {row.siteLabel}
                      </span>
                    ) : (
                      <span className="muted">Local</span>
                    )}
                  </td>
                  <td>
                    <div className="node-meta">
                      <span>{row.lastSeenDisplay}</span>
                      {row.lastSeenRelative && (
                        <span className="muted">{row.lastSeenRelative}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {row.location ?? (
                      <span className="muted">{row.online ? 'No fix yet' : 'Unavailable'}</span>
                    )}
                  </td>
                  <td>{row.temperature ?? <span className="muted">N/A</span>}</td>
                  <td className="last-message-cell">
                    {row.lastMessage ?? <span className="muted">No messages yet</span>}
                  </td>
                  <td className="actions-cell actions-cell--nodes">
                    <div className="node-actions-wrapper">
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => handleGoto(row)}
                        disabled={typeof row.lat !== 'number' || typeof row.lon !== 'number'}
                      >
                        Go to Map
                      </button>
                      <button
                        type="button"
                        className="control-chip control-chip--battery"
                        onClick={() => openBatterySaverDialog(row)}
                        disabled={!row.online || !canSendCommands}
                        title={
                          !canSendCommands
                            ? 'Requires OPERATOR or ADMIN role'
                            : !row.online
                              ? 'Node offline'
                              : 'Configure battery saver mode'
                        }
                      >
                        <BatteryIcon />
                        <span>Battery</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {batterySaverDialog && (
        <BatterySaverDialog
          nodeId={batterySaverDialog.nodeId}
          nodeName={batterySaverDialog.nodeName}
          siteId={batterySaverDialog.siteId}
          onClose={() => setBatterySaverDialog(null)}
        />
      )}
    </section>
  );
}

function buildRow(node: {
  id: string;
  name?: string | null;
  lat?: number | null;
  lon?: number | null;
  lastMessage?: string | null;
  lastSeen?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  siteColor?: string | null;
  siteCountry?: string | null;
  siteCity?: string | null;
  temperatureC?: number | null;
  temperatureF?: number | null;
  temperatureUpdatedAt?: string | null;
}): NodeRow {
  const lastSeenDate = node.lastSeen ? new Date(node.lastSeen) : undefined;
  const lastSeenDisplay = lastSeenDate ? lastSeenDate.toLocaleString() : 'Unknown';
  const lastSeenRelative = lastSeenDate ? formatRelativeTime(lastSeenDate) : null;
  const online = lastSeenDate ? Date.now() - lastSeenDate.getTime() <= ONLINE_THRESHOLD_MS : true;
  const lastSeenMs = lastSeenDate?.getTime() ?? null;

  const latValue = Number(node.lat ?? NaN);
  const lonValue = Number(node.lon ?? NaN);
  const hasCoords =
    Number.isFinite(latValue) && Number.isFinite(lonValue) && !(latValue === 0 && lonValue === 0);
  const lat = hasCoords ? latValue : undefined;
  const lon = hasCoords ? lonValue : undefined;
  const location = lat != null && lon != null ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : undefined;

  const temperatureInfo = resolveTemperatureInfo(node);
  const temperature = temperatureInfo.display;
  const locationTokens = [node.siteCountry, node.siteCity].filter(Boolean) as string[];
  const locationLabel = locationTokens.length > 0 ? locationTokens.join(' / ') : null;
  const primaryLabel = locationLabel ?? node.siteName ?? node.siteId ?? 'Local';
  const displayName = `${primaryLabel}:${node.name ?? node.id}`;
  const key = composeNodeKey(node.id, node.siteId ?? undefined);

  return {
    key,
    nodeId: node.id,
    displayName,
    online,
    lastSeenMs,
    lastSeenDisplay,
    lastSeenRelative,
    location,
    temperature,
    temperatureValue: temperatureInfo.valueC,
    lastMessage: node.lastMessage ?? undefined,
    lat,
    lon,
    siteId: node.siteId ?? undefined,
    siteLabel: primaryLabel,
    siteColor: node.siteColor ?? undefined,
    siteCountry: node.siteCountry ?? undefined,
    siteCity: node.siteCity ?? undefined,
  };
}

interface NodeRow {
  key: string;
  nodeId: string;
  displayName: string;
  online: boolean;
  lastSeenMs: number | null;
  lastSeenDisplay: string;
  lastSeenRelative: string | null;
  location?: string;
  temperature?: string;
  temperatureValue?: number;
  lastMessage?: string;
  lat?: number;
  lon?: number;
  siteId?: string;
  siteLabel?: string;
  siteColor?: string;
  siteCountry?: string;
  siteCity?: string;
}

function formatRelativeTime(date: Date): string | null {
  const diff = Date.now() - date.getTime();
  if (Number.isNaN(diff)) {
    return null;
  }
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function resolveTemperatureInfo(node: {
  temperatureC?: number | null;
  temperatureF?: number | null;
  lastMessage?: string | null;
}): { display?: string; valueC?: number } {
  if (typeof node.temperatureC === 'number' && Number.isFinite(node.temperatureC)) {
    return { display: `${node.temperatureC.toFixed(1)} C`, valueC: node.temperatureC };
  }
  if (typeof node.temperatureF === 'number' && Number.isFinite(node.temperatureF)) {
    const valueC = fahrenheitToCelsius(node.temperatureF);
    return { display: `${node.temperatureF.toFixed(1)} F`, valueC };
  }
  const measurement = parseTemperatureFromMessage(node.lastMessage);
  if (measurement) {
    const valueC =
      measurement.unit === 'C' ? measurement.value : fahrenheitToCelsius(measurement.value);
    return { display: `${measurement.value.toFixed(1)} ${measurement.unit}`, valueC };
  }
  return {};
}

function parseTemperatureFromMessage(
  message?: string | null,
): { value: number; unit: 'C' | 'F' } | null {
  if (!message) {
    return null;
  }
  const match = /temp(?:erature)?[=:]?\s*(-?\d+(?:\.\d+)?)\s*(?:([CFcf]))?/i.exec(message);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  const unitRaw = match[2];
  const unit = unitRaw ? (unitRaw.toUpperCase() === 'F' ? 'F' : 'C') : 'C';
  return { value, unit };
}

function fahrenheitToCelsius(value: number): number {
  return ((value - 32) * 5) / 9;
}

function composeNodeKey(nodeId: string, siteId?: string | null): string {
  return `${siteId ?? 'default'}::${nodeId}`;
}

function sortRows(rows: NodeRow[], sortKey: NodeSortKey, direction: SortDirection): NodeRow[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const comparison = compareNodeRows(a, b, sortKey);
    return comparison * multiplier;
  });
}

function compareNodeRows(a: NodeRow, b: NodeRow, key: NodeSortKey): number {
  switch (key) {
    case 'node':
      return compareStrings(a.displayName, b.displayName);
    case 'status':
      return compareNumbers(a.online ? 1 : 0, b.online ? 1 : 0);
    case 'site':
      return compareStrings(a.siteLabel ?? '', b.siteLabel ?? '');
    case 'lastSeen':
      return compareNumbers(
        a.lastSeenMs ?? Number.NEGATIVE_INFINITY,
        b.lastSeenMs ?? Number.NEGATIVE_INFINITY,
      );
    case 'location':
      return compareStrings(a.location ?? '', b.location ?? '');
    case 'temperature':
      return compareNumbers(
        a.temperatureValue ?? Number.NEGATIVE_INFINITY,
        b.temperatureValue ?? Number.NEGATIVE_INFINITY,
      );
    case 'lastMessage':
      return compareStrings(a.lastMessage ?? '', b.lastMessage ?? '');
    default:
      return 0;
  }
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

function compareNumbers(a: number, b: number): number {
  if (!Number.isFinite(a) && !Number.isFinite(b)) {
    return 0;
  }
  if (!Number.isFinite(a)) {
    return -1;
  }
  if (!Number.isFinite(b)) {
    return 1;
  }
  return a - b;
}

function getDefaultDirection(column: NodeSortKey): SortDirection {
  if (column === 'lastSeen' || column === 'status') {
    return 'desc';
  }
  return 'asc';
}
