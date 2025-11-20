import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiClient } from '../api/client';
import { InventoryDevice, SiteSummary } from '../api/types';
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
  | 'site'
  | 'lastNode'
  | 'lastLat';

const SITE_COLORS = ['#3b82f6', '#f87171', '#34d399', '#fbbf24', '#a78bfa'];
const RSSI_COLORS = ['#22c55e', '#f97316', '#ef4444'];

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
  const canDeleteDevice = role === 'ADMIN';

  const { data, isLoading, isError, refetch } = useQuery<InventoryDevice[]>({
    queryKey: ['inventory', search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      return apiClient.get<InventoryDevice[]>(`/inventory${params}`);
    },
    refetchInterval: autoRefreshMs,
    refetchIntervalInBackground: true,
  });

  const { data: sitesData } = useQuery<SiteSummary[]>({
    queryKey: ['sites'],
    queryFn: async () => apiClient.get<SiteSummary[]>('/sites'),
  });
  const siteLookup = useMemo(() => {
    const map = new Map<string, string>();
    (sitesData ?? []).forEach((site) => {
      if (site.id) {
        map.set(site.id, site.name ?? site.id);
      }
    });
    return map;
  }, [sitesData]);
  const resolveSiteLabel = useCallback(
    (siteId?: string | null) => {
      if (!siteId) {
        return 'Unassigned';
      }
      return siteLookup.get(siteId) ?? siteId;
    },
    [siteLookup],
  );

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

  const deleteDeviceMutation = useMutation({
    mutationFn: async (device: InventoryDevice) =>
      apiClient.delete(`/inventory/${encodeURIComponent(device.mac)}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
      await queryClient.invalidateQueries({ queryKey: ['targets'] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error && 'message' in error
            ? String((error as { message?: unknown }).message)
            : 'Unable to remove device';
      window.alert(message);
    },
  });

  const sortedData = useMemo(() => {
    if (!data) {
      return [];
    }
    const multiplier = sortDirection === 'asc' ? 1 : -1;
    return [...data].sort((a, b) => {
      const result = compareInventoryDevices(a, b, sortKey, siteLookup);
      return result * multiplier;
    });
  }, [data, sortDirection, sortKey, siteLookup]);

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
                <th aria-sort={ariaSort('site')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('site')}
                  >
                    Site {renderSortIcon('site')}
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
                    <td>{resolveSiteLabel(device.siteId)}</td>
                    <td>
                      {locationKnown
                        ? `${device.lastLat!.toFixed(5)}, ${device.lastLon!.toFixed(5)}`
                        : 'N/A'}
                    </td>
                    <td>
                      <div className="inventory-actions">
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
                        {canDeleteDevice ? (
                          <button
                            type="button"
                            className="control-chip control-chip--danger"
                            onClick={() => {
                              if (
                                window.confirm(`Remove device ${device.mac} from inventory list?`)
                              ) {
                                deleteDeviceMutation.mutate(device);
                              }
                            }}
                            disabled={deleteDeviceMutation.isPending}
                            title="Remove this device from inventory"
                          >
                            {deleteDeviceMutation.isPending ? 'Removing...' : 'Remove'}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {isAnalyticsOpen && (
        <InventoryAnalyticsDialog
          devices={data ?? []}
          sites={sitesData ?? []}
          onClose={() => setAnalyticsOpen(false)}
        />
      )}
    </section>
  );
}

interface InventoryAnalyticsDialogProps {
  devices: InventoryDevice[];
  sites: SiteSummary[];
  onClose: () => void;
}

function InventoryAnalyticsDialog({ devices, sites, onClose }: InventoryAnalyticsDialogProps) {
  const siteLookup = useMemo(() => {
    const map = new Map<string, SiteSummary>();
    sites.forEach((site) => {
      map.set(site.id, site);
    });
    return map;
  }, [sites]);
  const [selectedSite, setSelectedSite] = useState<string>('__ALL__');
  const filteredDevices = useMemo(() => {
    if (selectedSite === '__ALL__') {
      return devices;
    }
    const normalized = selectedSite === '__UNKNOWN__' ? null : selectedSite;
    return devices.filter((device) => (device.siteId ?? null) === normalized);
  }, [devices, selectedSite]);
  const analytics = useMemo(() => computeInventoryAnalytics(filteredDevices), [filteredDevices]);
  const siteStatsWithLabels = useMemo(
    () =>
      analytics.siteStats.map((site) => ({
        ...site,
        label:
          site.id === '__UNKNOWN__'
            ? 'Unknown site'
            : (siteLookup.get(site.id)?.name ?? site.label ?? site.id),
      })),
    [analytics.siteStats, siteLookup],
  );
  const siteOptions = useMemo(() => {
    if (siteStatsWithLabels.length === 0 && siteLookup.size > 0) {
      return Array.from(siteLookup.values()).map((site) => ({
        id: site.id,
        label: site.name ?? site.id,
        count: 0,
      }));
    }
    return siteStatsWithLabels;
  }, [siteLookup, siteStatsWithLabels]);
  const rssiChartData = useMemo(
    () =>
      analytics.rssiBuckets.map((bucket, idx) => ({
        label: bucket.label,
        value: bucket.value,
        color: RSSI_COLORS[idx % RSSI_COLORS.length],
      })),
    [analytics.rssiBuckets],
  );
  const siteChartData = useMemo(() => {
    const nodes = siteStatsWithLabels.slice(0, 5);
    return nodes.map((site, idx) => ({
      label: site.label,
      value: site.count,
      color: SITE_COLORS[idx % SITE_COLORS.length],
    }));
  }, [siteStatsWithLabels]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleExport = useCallback(() => {
    const rows: string[][] = [
      ['Metric', 'Value'],
      ['Total devices', analytics.totalDevices.toString()],
      ['Unique vendors', analytics.uniqueVendors.toString()],
      ['Unique SSIDs', analytics.uniqueSsids.toString()],
      ['Average RSSI', analytics.averageRssi ?? 'N/A'],
      ['Last sighting', analytics.lastSeenLabel ?? 'N/A'],
      [],
      ['Top Vendors'],
      ...analytics.topVendors.map((entry) => [entry.label, entry.value.toString()]),
      [],
      ['Top SSIDs'],
      ...analytics.topSsids.map((entry) => [entry.label, entry.value.toString()]),
      [],
      ['Signal Buckets'],
      ...analytics.rssiBuckets.map((entry) => [
        entry.label,
        `${entry.value} (${entry.percent?.toFixed(1) ?? '0.0'}%)`,
      ]),
    ];
    const csv = rows.map((row) => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'inventory-analytics.csv';
    link.click();
    URL.revokeObjectURL(url);
  }, [analytics]);

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

        <div className="inventory-analytics__controls">
          <label>
            Site:
            <select value={selectedSite} onChange={(event) => setSelectedSite(event.target.value)}>
              <option value="__ALL__">All sites ({devices.length})</option>
              {siteOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="control-chip" onClick={handleExport}>
            Export CSV
          </button>
        </div>

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
          {analytics.rssiBuckets.length === 0 ? (
            <p className="empty-state">No signal data available.</p>
          ) : (
            <div className="inventory-analytics__chart-row">
              <DonutChart data={rssiChartData} label="RSSI" />
              <ul className="inventory-analytics__legend">
                {rssiChartData.map((entry) => {
                  const percent =
                    analytics.totalDevices > 0 ? (entry.value / analytics.totalDevices) * 100 : 0;
                  return (
                    <li key={entry.label}>
                      <span
                        className="inventory-analytics__legend-swatch"
                        style={{ background: entry.color }}
                      />
                      <span>{entry.label}</span>
                      <strong>
                        {entry.value} ({percent.toFixed(1)}%)
                      </strong>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
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

        <section>
          <header className="inventory-analytics__section-header">
            <h3>Hourly activity (last 12h)</h3>
          </header>
          {analytics.hourlyTrend.length === 0 ? (
            <p className="empty-state">No recent activity.</p>
          ) : (
            <div className="inventory-analytics__sparkline">
              <SparklineChart data={analytics.hourlyTrend} />
              <div className="inventory-analytics__sparkline-legend">
                <span>Now</span>
                <span>−12h</span>
              </div>
            </div>
          )}
        </section>

        <section>
          <header className="inventory-analytics__section-header">
            <h3>Site breakdown</h3>
          </header>
          {siteStatsWithLabels.length === 0 ? (
            <p className="empty-state">No site assignments available.</p>
          ) : (
            <>
              <div className="inventory-analytics__chart-row">
                <DonutChart data={siteChartData} label="Sites" totalOverride={siteLookup.size} />
                <ul className="inventory-analytics__legend">
                  {siteChartData.map((site) => {
                    const percent =
                      analytics.totalDevices > 0 ? (site.value / analytics.totalDevices) * 100 : 0;
                    return (
                      <li key={site.label}>
                        <span
                          className="inventory-analytics__legend-swatch"
                          style={{ background: site.color }}
                        />
                        <span>{site.label}</span>
                        <strong>
                          {site.value} ({percent.toFixed(1)}%)
                        </strong>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <ul className="inventory-analytics__list inventory-analytics__list--inline">
                {siteStatsWithLabels.map((site) => (
                  <li key={site.id}>
                    <span>{site.label}</span>
                    <strong>{site.count}</strong>
                  </li>
                ))}
              </ul>
            </>
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
  const siteCounts = new Map<string, number>();
  const rssis: number[] = [];
  const bucketCounts = {
    strong: 0,
    medium: 0,
    weak: 0,
  };
  let latestSeen: number | null = null;
  const hourMs = 60 * 60 * 1000;
  const now = Date.now();
  const hourlyBuckets = Array.from({ length: 12 }).map((_, idx) => {
    const start = now - (12 - idx) * hourMs;
    const end = start + hourMs;
    return {
      start,
      end,
      label: new Date(start).toLocaleTimeString([], { hour: '2-digit' }),
      count: 0,
    };
  });

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

    const siteKey = device.siteId ?? '__UNKNOWN__';
    siteCounts.set(siteKey, (siteCounts.get(siteKey) ?? 0) + 1);

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
        hourlyBuckets.forEach((bucket) => {
          if (parsed >= bucket.start && parsed < bucket.end) {
            bucket.count += 1;
          }
        });
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

  const siteStats = Array.from(siteCounts.entries())
    .map(([id, count]) => ({
      id,
      label: id === '__UNKNOWN__' ? 'Unknown site' : id,
      count,
    }))
    .sort((a, b) => b.count - a.count);

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
    hourlyTrend: hourlyBuckets.map((bucket) => ({
      label: bucket.label,
      count: bucket.count,
    })),
    siteStats,
  };
}
function compareInventoryDevices(
  a: InventoryDevice,
  b: InventoryDevice,
  key: InventorySortKey,
  siteLookup?: Map<string, string>,
) {
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
    case 'site': {
      const labelA = resolveSiteSortLabel(a.siteId, siteLookup);
      const labelB = resolveSiteSortLabel(b.siteId, siteLookup);
      return compareStrings(labelA, labelB);
    }
    case 'lastNode':
      return compareStrings(a.lastNodeId, b.lastNodeId);
    case 'lastLat':
      return compareNumbers(a.lastLat, b.lastLat);
    default:
      return 0;
  }
}

function resolveSiteSortLabel(siteId?: string | null, siteLookup?: Map<string, string>) {
  if (!siteId) {
    return 'Unassigned';
  }
  return siteLookup?.get(siteId) ?? siteId;
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

type SparklineDatum = { label: string; count: number };

interface SparklineChartProps {
  data: SparklineDatum[];
  height?: number;
  width?: number;
}

function SparklineChart({ data, height = 140, width = 360 }: SparklineChartProps) {
  if (!data.length) {
    return null;
  }
  const max = Math.max(...data.map((item) => item.count), 1);
  const step = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data
    .map((item, index) => {
      const x = step * index;
      const ratio = max === 0 ? 0 : item.count / max;
      const y = height - ratio * height;
      return `${x},${y}`;
    })
    .join(' ');
  const areaPoints = `${points} ${width},${height} 0,${height}`;

  return (
    <svg
      className="sparkline-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Hourly detections"
    >
      <polyline points={areaPoints} className="sparkline-chart__area" />
      <polyline points={points} className="sparkline-chart__line" />
    </svg>
  );
}

interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  data: DonutSlice[];
  size?: number;
  label?: string;
  totalOverride?: number;
}

function DonutChart({ data, size = 160, label, totalOverride }: DonutChartProps) {
  const computedTotal = data.reduce((sum, slice) => sum + slice.value, 0);
  const total = typeof totalOverride === 'number' ? totalOverride : computedTotal;
  if (total === 0) {
    return (
      <div className="donut-chart donut-chart--empty" style={{ width: size, height: size }}>
        <span>No data</span>
      </div>
    );
  }
  let cumulative = 0;
  const gradientSegments = data
    .map((slice) => {
      const start = cumulative;
      cumulative += (slice.value / total) * 100;
      return `${slice.color} ${start}% ${cumulative}%`;
    })
    .join(', ');

  return (
    <div
      className="donut-chart"
      style={{ width: size, height: size, background: `conic-gradient(${gradientSegments})` }}
      aria-label="Donut chart"
    >
      <div className="donut-chart__label">
        <strong>{total}</strong>
        {label ? <span>{label}</span> : null}
      </div>
    </div>
  );
}
