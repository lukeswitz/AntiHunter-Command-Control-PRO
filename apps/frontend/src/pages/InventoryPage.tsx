import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { apiClient } from '../api/client';
import { InventoryDevice } from '../api/types';
import { useAuthStore } from '../stores/auth-store';

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
  const queryClient = useQueryClient();
  const role = useAuthStore((state) => state.user?.role ?? null);

  const canPromote = role === 'ADMIN' || role === 'OPERATOR';
  const canClear = role === 'ADMIN';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['inventory', search],
    queryFn: async () => {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      return apiClient.get<InventoryDevice[]>(`/inventory${params}`);
    },
    refetchInterval: autoRefreshMs,
    refetchIntervalInBackground: true,
    keepPreviousData: true,
  });

  useEffect(() => {
    const nextInterval = !data || data.length === 0 ? 2000 : 10000;
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
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
      await queryClient.invalidateQueries({ queryKey: ['targets'] });
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
                        disabled={promoteMutation.isPending || !locationKnown || !canPromote}
                        title={
                          locationKnown
                            ? 'Promote device to targets list'
                            : 'Awaiting coordinate fix before promotion'
                        }
                      >
                        {promoteMutation.isPending ? 'Promoting...' : 'Promote to Target'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
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
