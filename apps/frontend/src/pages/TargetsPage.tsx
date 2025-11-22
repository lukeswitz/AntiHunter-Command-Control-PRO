import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangeEvent, useMemo, useState, useRef, useEffect } from 'react';

import { apiClient } from '../api/client';
import type { CommandRequest, InventoryDevice, Target } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { useTargetStore } from '../stores/target-store';
import { useTrackingBannerStore } from '../stores/tracking-banner-store';
import { useTrackingSessionStore } from '../stores/tracking-session-store';
import { useTriangulationStore } from '../stores/triangulation-store';

const DEFAULT_TRIANGULATION_DURATION = 300;
const DEFAULT_SCAN_DURATION = 60;
const TRIANGULATE_DEBOUNCE_MS = 3000;

type TargetSortKey =
  | 'name'
  | 'mac'
  | 'vendor'
  | 'type'
  | 'ssid'
  | 'status'
  | 'firstNode'
  | 'lat'
  | 'updated';

interface TriangulatePayload {
  target: Target;
  duration?: number;
}

interface TrackPayload {
  target: Target;
  duration?: number;
}

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
  const [sortKey, setSortKey] = useState<TargetSortKey>('updated');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
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
  const startTrackingSession = useTrackingSessionStore((state) => state.startSession);
  const stopTrackingSession = useTrackingSessionStore((state) => state.stopSession);
  const trackingTimeouts = useRef<Record<string, number>>({});
  const [triangulateLocked, setTriangulateLocked] = useState(false);
  const triangulateCooldownRef = useRef<number | null>(null);
  const triangulateGuardRef = useRef<boolean>(false);
  const startTriangulationCountdown = useTriangulationStore((state) => state.setCountdown);
  const requestTrackingCountdown = useTrackingBannerStore((state) => state.requestCountdown);
  useEffect(() => {
    return () => {
      Object.values(trackingTimeouts.current).forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      trackingTimeouts.current = {};
      if (triangulateCooldownRef.current) {
        window.clearTimeout(triangulateCooldownRef.current);
        triangulateCooldownRef.current = null;
      }
    };
  }, []);
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
    mutationFn: async ({
      target,
      duration = DEFAULT_TRIANGULATION_DURATION,
    }: TriangulatePayload) => {
      if (!target.mac) {
        throw new Error('Target MAC unknown');
      }
      const commandTarget = '@ALL';
      await sendCommand({
        target: commandTarget,
        name: 'TRIANGULATE_START',
        params: [target.mac, String(duration)],
      });
    },
    onSuccess: (_data, variables) => {
      const duration = variables.duration ?? DEFAULT_TRIANGULATION_DURATION;
      if (variables.target.mac) {
        startTriangulationCountdown(variables.target.mac, duration);
      }
      void queryClient.invalidateQueries({ queryKey: ['targets'] });
    },
  });

  const clearAutoStop = (targetId: string) => {
    const existing = trackingTimeouts.current[targetId];
    if (existing) {
      window.clearTimeout(existing);
      delete trackingTimeouts.current[targetId];
    }
  };

  const stopTrackingMutation = useMutation({
    mutationFn: async ({ target: _target }: TrackPayload) => {
      await sendCommand({
        target: '@ALL',
        name: 'STOP',
        params: [],
      });
    },
    onSuccess: (_result, variables) => {
      setTracking(variables.target.id, false);
      stopTrackingSession(variables.target.id);
      clearAutoStop(variables.target.id);
    },
  });

  const scheduleAutoStop = (target: Target, duration: number) => {
    clearAutoStop(target.id);
    trackingTimeouts.current[target.id] = window.setTimeout(() => {
      stopTrackingMutation.mutate({ target });
    }, duration * 1000);
  };

  const beginTriangulateCooldown = () => {
    setTriangulateLocked(true);
    triangulateGuardRef.current = true;
    if (triangulateCooldownRef.current) {
      window.clearTimeout(triangulateCooldownRef.current);
    }
    triangulateCooldownRef.current = window.setTimeout(() => {
      setTriangulateLocked(false);
      triangulateGuardRef.current = false;
      triangulateCooldownRef.current = null;
    }, TRIANGULATE_DEBOUNCE_MS);
  };

  const trackMutation = useMutation({
    mutationFn: async ({ target, duration = DEFAULT_SCAN_DURATION }: TrackPayload) => {
      if (!target.mac) {
        throw new Error('Target MAC unknown');
      }
      const commandTarget = normalizeNodeTarget(target.firstNodeId);
      if (!commandTarget || commandTarget === '@ALL') {
        throw new Error('First detecting node unknown; cannot start remote tracking.');
      }
      const siteId = target.siteId ?? undefined;
      await sendCommand({
        target: commandTarget,
        name: 'CONFIG_TARGETS',
        params: [target.mac],
        siteId,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await sendCommand({
        target: commandTarget,
        name: 'SCAN_START',
        params: ['2', String(duration), '1,6,11'],
        siteId,
      });
    },
    onSuccess: (_result, variables) => {
      const duration = variables.duration ?? DEFAULT_SCAN_DURATION;
      setTracking(variables.target.id, true);
      if (variables.target.mac) {
        startTrackingSession({
          targetId: variables.target.id,
          mac: variables.target.mac,
          label: variables.target.name ?? variables.target.mac ?? variables.target.id,
          duration,
        });
        requestTrackingCountdown(variables.target.mac, duration);
      }
      scheduleAutoStop(variables.target, duration);
    },
  });

  const handleTriangulateRequest = (target: Target) => {
    if (!target.mac) {
      window.alert('Target MAC unknown.');
      return;
    }
    if (triangulateLocked || triangulateGuardRef.current || triangulateMutation.isPending) {
      window.alert('Triangulation commands are cooling down. Please wait a moment.');
      return;
    }
    const input = window.prompt(
      'Enter triangulation duration in seconds (60-300)',
      String(DEFAULT_TRIANGULATION_DURATION),
    );
    if (input == null) {
      return;
    }
    const parsed = Number(input);
    if (!Number.isFinite(parsed)) {
      window.alert('Invalid duration.');
      return;
    }
    const duration = Math.max(60, Math.min(300, Math.round(parsed)));
    beginTriangulateCooldown();
    void triangulateMutation.mutateAsync({ target, duration }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to start triangulation.';
      window.alert(message);
    });
  };

  const handleTrackRequest = (target: Target) => {
    if (!target.mac) {
      window.alert('Target MAC unknown.');
      return;
    }
    const input = window.prompt(
      'Enter tracking duration in seconds (10-600)',
      String(DEFAULT_SCAN_DURATION),
    );
    if (input == null) {
      return;
    }
    const parsed = Number(input);
    if (!Number.isFinite(parsed)) {
      window.alert('Invalid duration.');
      return;
    }
    const duration = Math.max(10, Math.min(600, Math.round(parsed)));
    trackMutation.mutate({ target, duration });
  };

  const handleStopTrackingRequest = (target: Target) => {
    stopTrackingMutation.mutate({ target });
  };

  const handleDeleteTarget = (target: Target) => {
    if (!canClearTargets) {
      window.alert('You need ADMIN privileges to delete targets.');
      return;
    }
    if (!window.confirm(`Remove target ${getTargetName(target) ?? target.id}?`)) {
      return;
    }
    deleteTargetMutation.mutate(target.id);
  };

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

  const deleteTargetMutation = useMutation({
    mutationFn: async (targetId: string) =>
      apiClient.delete(`/targets/${encodeURIComponent(targetId)}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['targets'] });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error && 'message' in error
            ? String((error as { message?: unknown }).message)
            : 'Unable to delete target';
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

  const sortedTargets = useMemo(() => {
    const multiplier = sortDirection === 'asc' ? 1 : -1;
    return [...filteredTargets].sort((a, b) => {
      const result = compareTargets(a, b, sortKey, vendorMap);
      return result * multiplier;
    });
  }, [filteredTargets, sortDirection, sortKey, vendorMap]);

  const handleSort = (key: TargetSortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const renderSortIcon = (key: TargetSortKey) => {
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

  const ariaSort = (key: TargetSortKey): 'none' | 'ascending' | 'descending' =>
    sortKey === key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const totalTargets = sortedTargets.length;

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Targets (Experimental)</h1>
          <p className="panel__subtitle">
            Promoted detections, triangulation, and tracking orchestration.
          </p>
        </div>
        <div className="targets-header__actions">
          <div className="targets-header__summary">
            {totalTargets} target{totalTargets === 1 ? '' : 's'} promoted
          </div>
          <input
            className="control-input"
            placeholder="Search MAC, vendor, or name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="targets-header__buttons">
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
                const confirmed = window.confirm(
                  'Clear all targets? This removes all promoted devices.',
                );
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
          <div>No promoted targets yet. Promote a device from the inventory to manage it here.</div>
        </div>
      ) : (
        <div className="targets-table">
          <table>
            <thead>
              <tr>
                <th aria-sort={ariaSort('name')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('name')}>
                    Name {renderSortIcon('name')}
                  </button>
                </th>
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
                <th aria-sort={ariaSort('ssid')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('ssid')}>
                    SSID {renderSortIcon('ssid')}
                  </button>
                </th>
                <th aria-sort={ariaSort('status')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('status')}>
                    Status {renderSortIcon('status')}
                  </button>
                </th>
                <th aria-sort={ariaSort('firstNode')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('firstNode')}
                  >
                    First Node {renderSortIcon('firstNode')}
                  </button>
                </th>
                <th aria-sort={ariaSort('lat')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('lat')}>
                    Location {renderSortIcon('lat')}
                  </button>
                </th>
                <th aria-sort={ariaSort('updated')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('updated')}
                  >
                    Updated {renderSortIcon('updated')}
                  </button>
                </th>
                <th>Comment</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedTargets.map((target) => {
                const mac = target.mac?.toUpperCase() ?? '';
                const vendorEntry = mac ? vendorMap.get(mac) : undefined;
                const trackingEntry = trackingMap[target.id];
                const tracking = trackingEntry?.active ?? false;
                const comment = commentMap[target.id] ?? '';
                const location = `${target.lat.toFixed(5)}, ${target.lon.toFixed(5)}`;
                const firstNode =
                  normalizeNodeTarget(target.firstNodeId)?.replace(/^@/, '') ?? 'Unknown';
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
                            window.alert(
                              'You need OPERATOR or ADMIN privileges to start triangulation.',
                            );
                            return;
                          }
                          handleTriangulateRequest(target);
                        }}
                        disabled={
                          triangulateMutation.isPending ||
                          triangulateLocked ||
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
                            window.alert(
                              'You need OPERATOR or ADMIN privileges to control tracking.',
                            );
                            return;
                          }
                          if (tracking) {
                            handleStopTrackingRequest(target);
                          } else {
                            handleTrackRequest(target);
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
                      {canClearTargets ? (
                        <button
                          type="button"
                          className="control-chip control-chip--danger"
                          onClick={() => handleDeleteTarget(target)}
                          disabled={deleteTargetMutation.isPending}
                          title="Remove this target entry"
                        >
                          {deleteTargetMutation.isPending ? 'Removing...' : 'Clear'}
                        </button>
                      ) : null}
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

function compareTargets(
  a: Target,
  b: Target,
  key: TargetSortKey,
  vendorMap: Map<string, InventoryDevice>,
) {
  switch (key) {
    case 'name':
      return compareStrings(getTargetName(a), getTargetName(b));
    case 'mac':
      return compareStrings(a.mac?.toUpperCase(), b.mac?.toUpperCase());
    case 'vendor':
      return compareStrings(getVendor(a, vendorMap)?.vendor, getVendor(b, vendorMap)?.vendor);
    case 'type':
      return compareStrings(
        a.deviceType ?? getVendor(a, vendorMap)?.type,
        b.deviceType ?? getVendor(b, vendorMap)?.type,
      );
    case 'ssid':
      return compareStrings(getVendor(a, vendorMap)?.ssid, getVendor(b, vendorMap)?.ssid);
    case 'status':
      return compareStrings(a.status, b.status);
    case 'firstNode':
      return compareStrings(getFirstNodeLabel(a), getFirstNodeLabel(b));
    case 'lat':
      return compareNumbers(a.lat, b.lat);
    case 'updated':
      return compareNumbers(new Date(a.updatedAt).getTime(), new Date(b.updatedAt).getTime());
    default:
      return 0;
  }
}

function getTargetName(target: Target): string | undefined {
  return target.name ?? target.mac ?? target.id;
}

function getVendor(target: Target, vendorMap: Map<string, InventoryDevice>) {
  const mac = target.mac?.toUpperCase();
  if (!mac) {
    return undefined;
  }
  return vendorMap.get(mac);
}

function getFirstNodeLabel(target: Target): string | undefined {
  return normalizeNodeTarget(target.firstNodeId)?.replace(/^@/, '');
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
