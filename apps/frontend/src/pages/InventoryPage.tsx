import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiClient } from '../api/client';
import { InventoryDevice } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { useDroneStore } from '../stores/drone-store';
import { useMapCommandStore } from '../stores/map-command-store';

type InventorySortKey =
  | 'mac'
  | 'vendor'
  | 'type'
  | 'channel'
  | 'ssid'
  | 'hits'
  | 'lastSeen'
  | 'maxRssi'
  | 'minRssi'
  | 'avgRssi'
  | 'lastNode'
  | 'lastLat';

export function InventoryPage() {
  const [search, setSearch] = useState('');
  const [autoRefreshMs, setAutoRefreshMs] = useState(2000);
  const [sortKey, setSortKey] = useState<InventorySortKey>('lastSeen');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [isAnalyticsOpen, setAnalyticsOpen] = useState(false);
  const queryClient = useQueryClient();
  const role = useAuthStore((state) => state.user?.role ?? null);
  const gotoOnMap = useMapCommandStore((state) => state.goto);
  const resetDrones = useDroneStore((state) => state.setDrones);
  const navigate = useNavigate();

  const canPromote = role === 'ADMIN' || role === 'OPERATOR';
  const canClear = role === 'ADMIN';

  const { data, isLoading, isError, refetch } = useQuery<InventoryDevice[]>({
    queryKey: ['inventory', search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      return apiClient.get<InventoryDevice[]>(`/inventory${params}`);
    },
    refetchInterval: autoRefreshMs,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    const hasResults = Array.isArray(data) && data.length > 0;
    const nextInterval = hasResults ? 10000 : 2000;
    setAutoRefreshMs((current) => (current === nextInterval ? current : nextInterval));
  }, [data]);

  const promoteMutation = useMutation({
    mutationFn: async (device: InventoryDevice) =>
      apiClient.post(`/inventory/${encodeURIComponent(device.mac)}/promote`, {
        siteId: device.siteId ?? undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['targets'] });
      await refetch();
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error && 'message' in error
            ? String((error as { message?: unknown }).message)
            : 'Unable to promote device to target';
      window.alert(message);
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => apiClient.post('/inventory/clear', {}),
    onSuccess: async () => {
      resetDrones([]);
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
      await queryClient.invalidateQueries({ queryKey: ['targets'] });
      await queryClient.invalidateQueries({ queryKey: ['drones'] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error && 'message' in error
            ? String((error as { message?: unknown }).message)
            : 'Unable to clear inventory';
      window.alert(message);
    },
  });

  const sortedData = useMemo(() => {
    if (!data) {
      return [];
    }
    const multiplier = sortDirection === 'asc' ? 1 : -1;
    return [...data].sort((a, b) => {
      const result = compareInventoryDevices(a, b, sortKey);
      return result * multiplier;
    });
  }, [data, sortDirection, sortKey]);

  const handleSort = (key: InventorySortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const renderSortIcon = (key: InventorySortKey) => {
    if (sortKey !== key) {
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
  };

  const ariaSort = (key: InventorySortKey): 'none' | 'ascending' | 'descending' =>
    sortKey === key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const handleGoToMap = useCallback(
    (device: InventoryDevice) => {
      if (typeof device.lastLat !== 'number' || typeof device.lastLon !== 'number') {
        return;
      }
      gotoOnMap({
        lat: device.lastLat,
        lon: device.lastLon,
        zoom: 15,
        nodeId: device.lastNodeId ?? undefined,
      });
      navigate('/map');
    },
    [gotoOnMap, navigate],
  );

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Inventory</h1>
          <p className="panel__subtitle">
            Live device sightings with vendor resolution, RSSI trends, and target promotion.
          </p>
        </div>
        <div className="controls-row">
          <input
            className="control-input"
            placeholder="Search MAC or vendor"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="button" className="control-chip" onClick={() => refetch()}>
            Refresh
          </button>
          <button type="button" className="control-chip">
            Export CSV
          </button>
          <button
            type="button"
            className="control-chip"
            onClick={() => setAnalyticsOpen(true)}
            disabled={!data || data.length === 0}
          >
            Inventory analytics
          </button>
          <button
            type="button"
            className="control-chip control-chip--danger"
            onClick={() => {
              if (clearMutation.isPending) {
                return;
              }
              if (!canClear) {
                window.alert('You need ADMIN privileges to clear the inventory.');
                return;
              }
              const confirmed = window.confirm(
                'Clear all inventory records? This cannot be undone.',
              );
              if (!confirmed) {
                return;
              }
              clearMutation.mutate();
            }}
            disabled={clearMutation.isPending || !canClear}
          >
            {clearMutation.isPending ? 'Clearing...' : 'Clear Inventory'}
          </button>
        </div>
      </header>

      {isLoading ? (
        <div className="empty-state">
          <div>Loading inventory...</div>
        </div>
      ) : isError ? (
        <div className="empty-state">
          <div>Unable to load inventory. Check backend logs and try again.</div>
        </div>
      ) : !data || data.length === 0 ? (
        <div className="empty-state">
          <div>
            Inventory is empty. Start a device scan to populate sightings and resolve vendors.
          </div>
        </div>
      ) : (
        <div className="inventory-table">
          <table>
            <thead>
              <tr>
                <th aria-sort={ariaSort('mac')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('mac')}>
                    MAC {renderSortIcon('mac')}
                  </button>
                </th>
                <th aria-sort={ariaSort('vendor')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('vendor')}>
                    Vendor {renderSortIcon('vendor')}
                  </button>
                </th>
                <th aria-sort={ariaSort('type')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('type')}>
                    Type {renderSortIcon('type')}
                  </button>
                </th>
                <th aria-sort={ariaSort('channel')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('channel')}
                  >
                    Channel {renderSortIcon('channel')}
                  </button>
                </th>
                <th aria-sort={ariaSort('ssid')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('ssid')}>
                    SSID {renderSortIcon('ssid')}
                  </button>
                </th>
                <th aria-sort={ariaSort('hits')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('hits')}>
                    Hits {renderSortIcon('hits')}
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
                <th aria-sort={ariaSort('maxRssi')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('maxRssi')}
                  >
                    RSSI (max/min/avg) {renderSortIcon('maxRssi')}
                  </button>
                </th>
                <th aria-sort={ariaSort('lastNode')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('lastNode')}
                  >
                    Last Node {renderSortIcon('lastNode')}
                  </button>
                </th>
                <th aria-sort={ariaSort('lastLat')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('lastLat')}
                  >
                    Last Location {renderSortIcon('lastLat')}
                  </button>
                </th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedData.map((device) => {
                const locationKnown =
                  typeof device.lastLat === 'number' && typeof device.lastLon === 'number';
                const isDrone =
                  (device.type ?? '').trim().toLowerCase() === 'drone' && locationKnown;
                return (
                  <tr key={device.mac}>
                    <td>{device.mac}</td>
                    <td>{device.vendor ?? 'Unknown'}</td>
                    <td>{device.type ?? 'N/A'}</td>
                    <td>{device.channel != null ? device.channel : 'N/A'}</td>
                    <td>{device.ssid ?? 'N/A'}</td>
                    <td>{device.hits}</td>
                    <td>{device.lastSeen ? new Date(device.lastSeen).toLocaleString() : 'N/A'}</td>
                    <td>
                      {[
                        device.maxRSSI != null ? `max ${device.maxRSSI}` : null,
                        device.minRSSI != null ? `min ${device.minRSSI}` : null,
                        device.avgRSSI != null ? `avg ${device.avgRSSI.toFixed(1)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' / ') || 'N/A'}
                    </td>
                    <td>{device.lastNodeId ?? 'N/A'}</td>
                    <td>
                      {locationKnown
                        ? `${device.lastLat!.toFixed(5)}, ${device.lastLon!.toFixed(5)}`
                        : 'N/A'}
                    </td>
                    <td>
                      {isDrone ? (
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => handleGoToMap(device)}
                          disabled={!locationKnown}
                        >
                          Go to Map
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => {
                            if (!canPromote) {
                              window.alert(
                                'You need OPERATOR or ADMIN privileges to promote devices.',
                              );
                              return;
                            }
                            promoteMutation.mutate(device);
                          }}
                          disabled={promoteMutation.isPending || !canPromote}
                          title={
                            !canPromote
                              ? 'You need OPERATOR or ADMIN privileges to promote devices.'
                              : 'Promote device to targets list'
                          }
                        >
                          {promoteMutation.isPending ? 'Promoting...' : 'Promote to Target'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {isAnalyticsOpen && (
        <InventoryAnalyticsDialog devices={data ?? []} onClose={() => setAnalyticsOpen(false)} />
      )}
    </section>
  );
}

interface InventoryAnalyticsDialogProps {
  devices: InventoryDevice[];
  onClose: () => void;
}

function InventoryAnalyticsDialog({ devices, onClose }: InventoryAnalyticsDialogProps) {
  const analytics = useMemo(() => computeInventoryAnalytics(devices), [devices]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="inventory-analytics" role="dialog" aria-modal="true">
      <button
        type="button"
        className="inventory-analytics__backdrop"
        aria-label="Dismiss analytics overlay"
        onClick={onClose}
      />
      <div
        className="inventory-analytics__modal"
        role="document"
        aria-labelledby="inventory-analytics-title"
      >
        <header className="inventory-analytics__header">
          <div>
            <h2 id="inventory-analytics-title">Inventory analytics</h2>
            <p>
              Aggregated insights generated from {analytics.totalDevices} device
              {analytics.totalDevices === 1 ? '' : 's'} currently in inventory.
            </p>
          </div>
          <button type="button" className="control-chip control-chip--ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="inventory-analytics__metrics">
          <article>
            <strong>Total devices</strong>
            <span>{analytics.totalDevices}</span>
          </article>
          <article>
            <strong>Vendors seen</strong>
            <span>{analytics.uniqueVendors}</span>
          </article>
          <article>
            <strong>Unique SSIDs</strong>
            <span>{analytics.uniqueSsids}</span>
          </article>
          <article>
            <strong>Last sighting</strong>
            <span>{analytics.lastSeenLabel ?? 'N/A'}</span>
          </article>
          <article>
            <strong>Avg RSSI</strong>
            <span>{analytics.averageRssi ?? 'N/A'}</span>
          </article>
        </div>

        <section>
          <header className="inventory-analytics__section-header">
            <h3>Channel utilization</h3>
            <p>Distribution is based on the proportion of tracked devices per channel.</p>
          </header>
          {analytics.channelStats.length === 0 ? (
            <p className="empty-state">No channel data available.</p>
          ) : (
            <ul className="inventory-analytics__channels">
              {analytics.channelStats.map((stat) => (
                <li key={stat.channel}>
                  <div className="inventory-analytics__channel-meta">
                    <span>{stat.channel}</span>
                    <span>
                      {stat.count} ({stat.percent.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="inventory-analytics__progress" aria-hidden="true">
                    <span style={{ width: `${stat.percent}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="inventory-analytics__grid">
          <section>
            <header className="inventory-analytics__section-header">
              <h3>Top vendors</h3>
            </header>
            {analytics.topVendors.length === 0 ? (
              <p className="empty-state">No vendor data.</p>
            ) : (
              <ul className="inventory-analytics__list">
                {analytics.topVendors.map((entry) => (
                  <li key={entry.label}>
                    <span>{entry.label}</span>
                    <strong>{entry.value}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <header className="inventory-analytics__section-header">
              <h3>Top SSIDs</h3>
            </header>
            {analytics.topSsids.length === 0 ? (
              <p className="empty-state">No SSID data.</p>
            ) : (
              <ul className="inventory-analytics__list">
                {analytics.topSsids.map((entry) => (
                  <li key={entry.label}>
                    <span>{entry.label}</span>
                    <strong>{entry.value}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <header className="inventory-analytics__section-header">
              <h3>Nodes detecting the most devices</h3>
            </header>
            {analytics.topNodes.length === 0 ? (
              <p className="empty-state">No node data.</p>
            ) : (
              <ul className="inventory-analytics__list">
                {analytics.topNodes.map((entry) => (
                  <li key={entry.label}>
                    <span>{entry.label}</span>
                    <strong>{entry.value}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section>
          <header className="inventory-analytics__section-header">
            <h3>Signal quality snapshot</h3>
          </header>
          <ul className="inventory-analytics__list inventory-analytics__list--inline">
            {analytics.rssiBuckets.map((bucket) => {
              const percent = typeof bucket.percent === 'number' ? bucket.percent : 0;
              return (
                <li key={bucket.label}>
                  <span>{bucket.label}</span>
                  <strong>
                    {bucket.value} ({percent.toFixed(1)}%)
                  </strong>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <header className="inventory-analytics__section-header">
            <h3>Device types</h3>
          </header>
          {analytics.deviceTypes.length === 0 ? (
            <p className="empty-state">No classification available.</p>
          ) : (
            <ul className="inventory-analytics__list inventory-analytics__list--inline">
              {analytics.deviceTypes.map((entry) => (
                <li key={entry.label}>
                  <span>{entry.label}</span>
                  <strong>
                    {entry.value} ({entry.percent?.toFixed(1)}%)
                  </strong>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

interface AnalyticsStat {
  label: string;
  value: number;
  percent?: number;
}

function computeInventoryAnalytics(devices: InventoryDevice[]) {
  const totalDevices = devices.length;
  const vendorCounts = new Map<string, number>();
  const ssidCounts = new Map<string, number>();
  const channelCounts = new Map<string, number>();
  const nodeCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const rssis: number[] = [];
  const bucketCounts = {
    strong: 0,
    medium: 0,
    weak: 0,
  };
  let latestSeen: number | null = null;

  devices.forEach((device) => {
    const vendor = device.vendor?.trim() || 'Unknown vendor';
    vendorCounts.set(vendor, (vendorCounts.get(vendor) ?? 0) + 1);

    const ssid = device.ssid?.trim() || 'Hidden/Unknown';
    ssidCounts.set(ssid, (ssidCounts.get(ssid) ?? 0) + 1);

    const channel =
      typeof device.channel === 'number' && Number.isFinite(device.channel)
        ? `Channel ${device.channel}`
        : 'Unknown';
    channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);

    if (device.lastNodeId) {
      nodeCounts.set(device.lastNodeId, (nodeCounts.get(device.lastNodeId) ?? 0) + 1);
    }

    const typeLabel = device.type?.trim() || 'Unclassified';
    typeCounts.set(typeLabel, (typeCounts.get(typeLabel) ?? 0) + 1);

    if (typeof device.avgRSSI === 'number' && Number.isFinite(device.avgRSSI)) {
      rssis.push(device.avgRSSI);
      if (device.avgRSSI >= -50) {
        bucketCounts.strong += 1;
      } else if (device.avgRSSI >= -70) {
        bucketCounts.medium += 1;
      } else {
        bucketCounts.weak += 1;
      }
    }

    if (device.lastSeen) {
      const parsed = Date.parse(device.lastSeen);
      if (!Number.isNaN(parsed)) {
        latestSeen = latestSeen == null ? parsed : Math.max(latestSeen, parsed);
      }
    }
  });

  const buildTopList = (source: Map<string, number>, limit = 5): AnalyticsStat[] =>
    Array.from(source.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, value]) => ({ label, value }));

  const channelStats = Array.from(channelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([channel, count]) => ({
      channel,
      count,
      percent: totalDevices ? (count / totalDevices) * 100 : 0,
    }))
    .slice(0, 8);

  const averageRssi =
    rssis.length > 0
      ? `${(rssis.reduce((sum, value) => sum + value, 0) / rssis.length).toFixed(1)} dBm`
      : null;

  const rssiBuckets: AnalyticsStat[] = [
    { key: 'strong', label: 'Strong (≥ -50 dBm)' },
    { key: 'medium', label: 'Moderate (-70 to -51 dBm)' },
    { key: 'weak', label: 'Weak (≤ -71 dBm)' },
  ].map(({ key, label }) => {
    const value = bucketCounts[key as keyof typeof bucketCounts];
    return {
      label,
      value,
      percent: totalDevices ? (value / totalDevices) * 100 : 0,
    };
  });

  const deviceTypes: AnalyticsStat[] = Array.from(typeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({
      label,
      value,
      percent: totalDevices ? (value / totalDevices) * 100 : 0,
    }));

  return {
    totalDevices,
    uniqueVendors: vendorCounts.size,
    uniqueSsids: ssidCounts.size,
    lastSeenLabel: latestSeen ? new Date(latestSeen).toLocaleString() : null,
    averageRssi,
    channelStats,
    topVendors: buildTopList(vendorCounts),
    topSsids: buildTopList(ssidCounts),
    topNodes: buildTopList(nodeCounts),
    rssiBuckets,
    deviceTypes,
  };
}

function compareInventoryDevices(a: InventoryDevice, b: InventoryDevice, key: InventorySortKey) {
  switch (key) {
    case 'mac':
      return compareStrings(a.mac, b.mac);
    case 'vendor':
      return compareStrings(a.vendor, b.vendor);
    case 'type':
      return compareStrings(a.type, b.type);
    case 'channel':
      return compareNumbers(a.channel, b.channel);
    case 'ssid':
      return compareStrings(a.ssid, b.ssid);
    case 'hits':
      return compareNumbers(a.hits, b.hits);
    case 'lastSeen':
      return compareNumbers(
        a.lastSeen ? new Date(a.lastSeen).getTime() : 0,
        b.lastSeen ? new Date(b.lastSeen).getTime() : 0,
      );
    case 'maxRssi':
      return compareNumbers(a.maxRSSI, b.maxRSSI);
    case 'minRssi':
      return compareNumbers(a.minRSSI, b.minRSSI);
    case 'avgRssi':
      return compareNumbers(a.avgRSSI ?? null, b.avgRSSI ?? null);
    case 'lastNode':
      return compareStrings(a.lastNodeId, b.lastNodeId);
    case 'lastLat':
      return compareNumbers(a.lastLat, b.lastLat);
    default:
      return 0;
  }
}

function compareStrings(a?: string | null, b?: string | null): number {
  const valueA = (a ?? '').toUpperCase();
  const valueB = (b ?? '').toUpperCase();
  return valueA.localeCompare(valueB);
}

function compareNumbers(a?: number | null, b?: number | null): number {
  const valueA = typeof a === 'number' && Number.isFinite(a) ? a : Number.NEGATIVE_INFINITY;
  const valueB = typeof b === 'number' && Number.isFinite(b) ? b : Number.NEGATIVE_INFINITY;
  if (valueA === valueB) {
    return 0;
  }
  return valueA < valueB ? -1 : 1;
}
