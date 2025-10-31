import { ChangeEvent, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../api/client';
import type { CommandRequest, InventoryDevice, Target } from '../api/types';
import { useTargetStore } from '../stores/target-store';
import { useAuthStore } from '../stores/auth-store';

interface TriangulatePayload {
  target: Target;
  duration?: number;
}

interface TrackPayload {
  target: Target;
}

const DEFAULT_TRIANGULATION_DURATION = 300;
const DEFAULT_SCAN_DURATION = 60;

function normalizeNodeTarget(nodeId?: string | null): string | null {
  if (!nodeId) {
    return null;
  }
  const trimmed = nodeId.trim().toUpperCase();
  if (/^NODE_AH\d+$/.test(trimmed)) {
    return `@${trimmed.replace(/^NODE_/, '')}`;
  }
  if (/^AH\d+$/.test(trimmed)) {
    return `@${trimmed}`;
  }
  if (/^@?ALL$/i.test(trimmed)) {
    return '@ALL';
  }
  return `@${trimmed.replace(/^NODE_/, '').replace(/^@/, '')}`;
}

async function sendCommand(body: CommandRequest) {
  await apiClient.post('/commands/send', body);
}

export function TargetsPage() {
  const [search, setSearch] = useState('');
  const role = useAuthStore((state) => state.user?.role ?? null);
  const canManageTargets = role === 'ADMIN' || role === 'OPERATOR';
  const canClearTargets = role === 'ADMIN';
  const canSendCommands = canManageTargets;

  const { commentMap, trackingMap, setComment, setTracking, reset } = useTargetStore((state) => ({
    commentMap: state.commentMap,
    trackingMap: state.trackingMap,
    setComment: state.setComment,
    setTracking: state.setTracking,
    reset: state.reset,
  }));
  const queryClient = useQueryClient();

  const targetsQuery = useQuery({
    queryKey: ['targets'],
    queryFn: async () => apiClient.get<Target[]>('/targets'),
  });

  const inventoryQuery = useQuery({
    queryKey: ['inventory-all'],
    queryFn: async () => apiClient.get<InventoryDevice[]>('/inventory'),
  });

  const vendorMap = useMemo(() => {
    const map = new Map<string, InventoryDevice>();
    if (inventoryQuery.data) {
      inventoryQuery.data.forEach((device) => {
        map.set(device.mac.toUpperCase(), device);
      });
    }
    return map;
  }, [inventoryQuery.data]);

  const triangulateMutation = useMutation({
    mutationFn: async ({ target, duration = DEFAULT_TRIANGULATION_DURATION }: TriangulatePayload) => {
      if (!target.mac) {
        throw new Error('Target MAC unknown');
      }
      const commandTarget = normalizeNodeTarget(target.firstNodeId);
      if (!commandTarget || commandTarget === '@ALL') {
        throw new Error('First detecting node unknown');
      }
      await sendCommand({
        target: commandTarget,
        name: 'TRIANGULATE_START',
        params: [target.mac, String(duration)],
      });
    },
  });

  const trackMutation = useMutation({
    mutationFn: async ({ target }: TrackPayload) => {
      if (!target.mac) {
        throw new Error('Target MAC unknown');
      }
      await sendCommand({
        target: '@ALL',
        name: 'CONFIG_TARGETS',
        params: [target.mac],
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await sendCommand({
        target: '@ALL',
        name: 'SCAN_START',
        params: ['2', String(DEFAULT_SCAN_DURATION), '1,6,11'],
      });
      setTracking(target.id, true);
    },
  });

  const stopTrackingMutation = useMutation({
    mutationFn: async ({ target }: TrackPayload) => {
      await sendCommand({
        target: '@ALL',
        name: 'STOP',
        params: [],
      });
      setTracking(target.id, false);
    },
  });

  const clearTargetsMutation = useMutation({
    mutationFn: async () => apiClient.delete('/targets/clear'),
    onSuccess: async () => {
      reset();
      await queryClient.invalidateQueries({ queryKey: ['targets'] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: unknown }).message)
          : 'Unable to clear targets';
      window.alert(message);
    },
  });

  const filteredTargets = useMemo(() => {
    const targets = targetsQuery.data ?? [];
    const term = search.trim().toUpperCase();
    if (!term) {
      return targets;
    }
    return targets.filter((target) => {
      const mac = target.mac?.toUpperCase();
      const vendorEntry = mac ? vendorMap.get(mac) : undefined;
      return [target.name, mac, target.deviceType, vendorEntry?.vendor, vendorEntry?.ssid]
        .filter(Boolean)
        .some((value) => String(value).toUpperCase().includes(term));
    });
  }, [search, targetsQuery.data, vendorMap]);

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Targets</h1>
          <p className="panel__subtitle">
            Promoted detections, triangulation, and tracking orchestration.
          </p>
        </div>
        <div className="controls-row">
          <input
            className="control-input"
            placeholder="Search MAC, vendor, or name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button type="button" className="control-chip" onClick={() => targetsQuery.refetch()}>
            Refresh
          </button>
          <button
            type="button"
            className="control-chip control-chip--danger"
            onClick={() => {
              if (clearTargetsMutation.isPending) {
                return;
              }
              if (!canClearTargets) {
                window.alert('You need ADMIN privileges to clear all targets.');
                return;
              }
              const confirmed = window.confirm('Clear all targets? This removes all promoted devices.');
              if (!confirmed) {
                return;
              }
              clearTargetsMutation.mutate();
            }}
            disabled={clearTargetsMutation.isPending || !canClearTargets}
          >
            {clearTargetsMutation.isPending ? 'Clearing...' : 'Clear Targets'}
          </button>
        </div>
      </header>

      {targetsQuery.isLoading ? (
        <div className="empty-state">
          <div>Loading targets...</div>
        </div>
      ) : targetsQuery.isError ? (
        <div className="empty-state">
          <div>Unable to load targets. Check backend logs and try again.</div>
        </div>
      ) : filteredTargets.length === 0 ? (
        <div className="empty-state">
          <div>
            No promoted targets yet. Promote a device from the inventory to manage it here.
          </div>
        </div>
      ) : (
        <div className="targets-table">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>MAC</th>
                <th>Vendor</th>
                <th>Type</th>
                <th>SSID</th>
                <th>Status</th>
                <th>First Node</th>
                <th>Location</th>
                <th>Updated</th>
                <th>Comment</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredTargets.map((target) => {
                const mac = target.mac?.toUpperCase() ?? '';
                const vendorEntry = mac ? vendorMap.get(mac) : undefined;
                const trackingEntry = trackingMap[target.id];
                const tracking = trackingEntry?.active ?? false;
                const comment = commentMap[target.id] ?? '';
                const location = `${target.lat.toFixed(5)}, ${target.lon.toFixed(5)}`;
                const firstNode = normalizeNodeTarget(target.firstNodeId)?.replace(/^@/, '') ?? 'Unknown';
                const ssid = vendorEntry?.ssid ?? null;
                const statusLabel = target.status
                  .split('_')
                  .map((segment) => segment.charAt(0) + segment.slice(1).toLowerCase())
                  .join(' ');

                return (
                  <tr key={target.id} className={tracking ? 'tracking-row' : undefined}>
                    <td>{target.name ?? mac ?? target.id}</td>
                    <td>{mac || 'N/A'}</td>
                    <td>{vendorEntry?.vendor ?? 'Unknown'}</td>
                    <td>{target.deviceType ?? vendorEntry?.type ?? 'N/A'}</td>
                    <td>{ssid && ssid.trim() ? ssid : 'N/A'}</td>
                    <td>{statusLabel}</td>
                    <td>{firstNode}</td>
                    <td>{location}</td>
                    <td>{new Date(target.updatedAt).toLocaleString()}</td>
                    <td>
                      <textarea
                        className="comment-input"
                        rows={2}
                        value={comment}
                        placeholder="Operator notes"
                        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                          setComment(target.id, event.target.value)
                        }
                      />
                    </td>
                    <td className="actions-cell">
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => {
                          if (!canSendCommands) {
                            window.alert('You need OPERATOR or ADMIN privileges to start triangulation.');
                            return;
                          }
                          triangulateMutation.mutate({ target });
                        }}
                        disabled={
                          triangulateMutation.isPending ||
                          !target.mac ||
                          !target.firstNodeId ||
                          !normalizeNodeTarget(target.firstNodeId) ||
                          !canSendCommands
                        }
                        title="Start triangulation from first detecting node"
                      >
                        Triangulate
                      </button>
                      <button
                        type="button"
                        className={`control-chip ${tracking ? 'is-active' : ''}`}
                        onClick={() => {
                          if (!canSendCommands) {
                            window.alert('You need OPERATOR or ADMIN privileges to control tracking.');
                            return;
                          }
                          if (tracking) {
                            stopTrackingMutation.mutate({ target });
                          } else {
                            trackMutation.mutate({ target });
                          }
                        }}
                        disabled={
                          tracking
                            ? stopTrackingMutation.isPending
                            : trackMutation.isPending || !target.mac || !canSendCommands
                        }
                        title={tracking ? 'Stop tracking' : 'Start coordinated tracking'}
                      >
                        {tracking ? 'Tracking' : 'Track'}
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

