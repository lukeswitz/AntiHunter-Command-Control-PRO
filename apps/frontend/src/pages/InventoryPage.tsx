import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { apiClient } from '../api/client';
import { InventoryDevice } from '../api/types';
import { useAuthStore } from '../stores/auth-store';

export function InventoryPage() {
  const [search, setSearch] = useState('');
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
  });

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
                <th>MAC</th>
                <th>Vendor</th>
                <th>Type</th>
                <th>SSID</th>
                <th>Hits</th>
                <th>Last Seen</th>
                <th>RSSI (max/min/avg)</th>
                <th>Last Node</th>
                <th>Last Location</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((device) => {
                const locationKnown =
                  typeof device.lastLat === 'number' && typeof device.lastLon === 'number';
                return (
                  <tr key={device.mac}>
                    <td>{device.mac}</td>
                    <td>{device.vendor ?? 'Unknown'}</td>
                    <td>{device.type ?? 'N/A'}</td>
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
