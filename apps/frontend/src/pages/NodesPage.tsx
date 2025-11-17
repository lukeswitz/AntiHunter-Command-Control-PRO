import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiClient } from '../api/client';
import { useMapCommandStore } from '../stores/map-command-store';
import { useNodeStore } from '../stores/node-store';

const ONLINE_THRESHOLD_MS = 11 * 60 * 1000; // 11 minutes

export function NodesPage() {
  const nodes = useNodeStore((state) => state.nodes);
  const order = useNodeStore((state) => state.order);
  const clearNodes = useNodeStore((state) => state.clearAll);
  const gotoOnMap = useMapCommandStore((state) => state.goto);
  const navigate = useNavigate();

  const rows = useMemo(() => {
    return order
      .map((id) => nodes[id])
      .filter(Boolean)
      .map((node) => buildRow(node));
  }, [nodes, order]);

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

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Nodes</h1>
          <p className="panel__subtitle">
            Health snapshots for every mesh node: connectivity state, last telemetry, and location.
          </p>
        </div>
        <button type="button" className="control-chip" onClick={handleClearNodes}>
          Clear Nodes
        </button>
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
                <th>Node</th>
                <th>Status</th>
                <th>Site</th>
                <th>Last Seen</th>
                <th>Location</th>
                <th>Temperature</th>
                <th>Last Message</th>
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
                  <td>
                    <button
                      type="button"
                      className="control-chip"
                      onClick={() => handleGoto(row)}
                      disabled={typeof row.lat !== 'number' || typeof row.lon !== 'number'}
                    >
                      Go to Map
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function buildRow(node: {
  id: string;
  name?: string | null;
  lat: number;
  lon: number;
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

  const latValue = Number(node.lat);
  const lonValue = Number(node.lon);
  const hasCoords =
    Number.isFinite(latValue) && Number.isFinite(lonValue) && !(latValue === 0 && lonValue === 0);
  const lat = hasCoords ? latValue : undefined;
  const lon = hasCoords ? lonValue : undefined;
  const location = lat != null && lon != null ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : undefined;

  const temperature = formatTemperature(node);
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
    lastSeenDisplay,
    lastSeenRelative,
    location,
    temperature,
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
  lastSeenDisplay: string;
  lastSeenRelative: string | null;
  location?: string;
  temperature?: string;
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

function formatTemperature(node: {
  temperatureC?: number | null;
  temperatureF?: number | null;
  lastMessage?: string | null;
}): string | undefined {
  if (typeof node.temperatureC === 'number' && Number.isFinite(node.temperatureC)) {
    return `${node.temperatureC.toFixed(1)} °C`;
  }
  if (typeof node.temperatureF === 'number' && Number.isFinite(node.temperatureF)) {
    return `${node.temperatureF.toFixed(1)} °F`;
  }
  return extractTemperature(node.lastMessage);
}

function extractTemperature(message?: string | null): string | undefined {
  if (!message) {
    return undefined;
  }
  const match = /temp(?:erature)?[=:]?\s*(-?\d+(?:\.\d+)?)\s*(?:[�\s-]*([CFcf]))?/i.exec(message);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = match[2] ? match[2].toUpperCase() : 'C';
  return `${value.toFixed(1)} ${unit}`;
}
function composeNodeKey(nodeId: string, siteId?: string | null): string {
  return `${siteId ?? 'default'}::${nodeId}`;
}
