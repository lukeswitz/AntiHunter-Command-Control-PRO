import classNames from 'clsx';
import { useEffect, useState } from 'react';

import type { DroneStatus, FaaAircraftSummary } from '../api/types';
import type { DroneMarker } from '../stores/drone-store';

type StatusOption = {
  value: DroneStatus;
  label: string;
};

interface DroneFloatingCardProps {
  drones: DroneMarker[];
  activeDroneId: string | null;
  visible: boolean;
  onClose: () => void;
  onSelect: (droneId: string, options?: { focus?: boolean }) => void;
  onStatusChange?: (droneId: string, status: DroneStatus) => void;
  statusOptions?: StatusOption[];
  isStatusUpdating?: (droneId: string) => boolean;
  canManage?: boolean;
}

export function DroneFloatingCard({
  drones,
  activeDroneId,
  visible,
  onClose,
  onSelect,
  onStatusChange,
  statusOptions = [],
  isStatusUpdating,
  canManage = false,
}: DroneFloatingCardProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [frozenDrones, setFrozenDrones] = useState<DroneMarker[]>(drones);

  useEffect(() => {
    if (!editingId) {
      setFrozenDrones(drones);
    } else {
      setFrozenDrones(
        (prev) =>
          prev
            .map((existing) => drones.find((item) => item.id === existing.id) ?? existing)
            .filter(Boolean) as DroneMarker[],
      );
    }
  }, [drones, editingId]);

  if (drones.length === 0 && frozenDrones.length === 0) {
    return null;
  }

  const displayDrones = editingId ? frozenDrones : drones;

  const statusCounts = displayDrones.reduce<Record<DroneStatus, number>>(
    (acc, drone) => {
      acc[drone.status] = (acc[drone.status] ?? 0) + 1;
      return acc;
    },
    {
      UNKNOWN: 0,
      FRIENDLY: 0,
      NEUTRAL: 0,
      HOSTILE: 0,
    },
  );

  const sortedDrones =
    editingId != null
      ? displayDrones
      : [...displayDrones].sort(
          (a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
        );

  const freshestDrone = sortedDrones[0];

  return (
    <section
      className={classNames('drone-floating-card', { 'drone-floating-card--visible': visible })}
      aria-live="polite"
    >
      <header className="drone-floating-card__header">
        <div>
          <h3>Drone Tracker & Inventory</h3>
          <p className="muted">
            {displayDrones.length} detected / Updated{' '}
            {freshestDrone ? formatRelativeTime(freshestDrone.lastSeen, 'short') : 'unknown'}
          </p>
        </div>
        <button type="button" className="control-chip control-chip--ghost" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="drone-floating-card__body">
        <div className="drone-floating-card__list">
          <div className="drone-floating-card__section-title">Inventory</div>
          <div className="drone-floating-card__status-summary">
            {(['UNKNOWN', 'FRIENDLY', 'NEUTRAL', 'HOSTILE'] as DroneStatus[]).map((status) => (
              <span
                key={status}
                className={`drone-status-badge drone-status-badge--${status.toLowerCase()}`}
              >
                {formatDroneStatusLabel(status)}: {statusCounts[status] ?? 0}
              </span>
            ))}
          </div>
          <div className="drone-floating-card__table-wrapper drone-floating-card__table-wrapper--wide">
            <table className="drone-floating-card__table drone-floating-card__table--wide">
              <thead>
                <tr>
                  <th>Drone</th>
                  <th>Status</th>
                  <th>Node</th>
                  <th>MAC</th>
                  <th>Coordinates</th>
                  <th>Altitude</th>
                  <th>Speed</th>
                  <th>Signal</th>
                  <th>Operator</th>
                  <th>Heading</th>
                  <th>RID Data</th>
                  <th>Last Seen</th>
                  <th>Source</th>
                  <th>Go To</th>
                </tr>
              </thead>
              <tbody>
                {sortedDrones.map((drone, index) => {
                  const isActive = drone.id === activeDroneId;
                  const isMostRecent = index === 0;
                  return (
                    <tr
                      key={drone.id}
                      className={classNames({
                        'is-active': isActive,
                        'is-hostile': drone.status === 'HOSTILE',
                        'is-most-recent': isMostRecent,
                      })}
                      onClick={() => onSelect(drone.id)}
                    >
                      <td>
                        <strong>{drone.droneId ?? drone.id}</strong>
                        <div className="muted">{drone.siteName ?? drone.siteId ?? 'Local'}</div>
                      </td>
                      <td>
                        {onStatusChange && canManage ? (
                          <select
                            className="control-input drone-floating-card__status-select"
                            value={drone.status}
                            onClick={(event) => event.stopPropagation()}
                            onFocus={() => setEditingId(drone.id)}
                            onBlur={() =>
                              setEditingId((current) => (current === drone.id ? null : current))
                            }
                            onChange={(event) => {
                              const nextStatus = event.target.value as DroneStatus;
                              setFrozenDrones((prev) =>
                                prev.map((item) =>
                                  item.id === drone.id ? { ...item, status: nextStatus } : item,
                                ),
                              );
                              onStatusChange(drone.id, nextStatus);
                            }}
                            disabled={isStatusUpdating?.(drone.id)}
                          >
                            {statusOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span
                            className={`drone-status-badge drone-status-badge--${formatDroneStatusClass(drone.status)}`}
                          >
                            {formatDroneStatusLabel(drone.status)}
                          </span>
                        )}
                      </td>
                      <td>{drone.nodeId ?? 'N/A'}</td>
                      <td>{drone.mac ?? 'N/A'}</td>
                      <td>
                        {formatCoordinate(drone.lat)}, {formatCoordinate(drone.lon)}
                      </td>
                      <td>
                        {typeof drone.altitude === 'number'
                          ? `${drone.altitude.toFixed(1)} m`
                          : 'N/A'}
                      </td>
                      <td>
                        {typeof drone.speed === 'number' ? `${drone.speed.toFixed(1)} m/s` : 'N/A'}
                      </td>
                      <td>{typeof drone.rssi === 'number' ? `${drone.rssi} dBm` : 'N/A'}</td>
                      <td>
                        {drone.operatorLat != null && drone.operatorLon != null
                          ? `${formatCoordinate(drone.operatorLat)}, ${formatCoordinate(drone.operatorLon)}`
                          : 'Unknown'}
                      </td>
                      <td>{formatHeading(drone)}</td>
                      <td>{renderRidInfo(drone.faa)}</td>
                      <td>{formatRelativeTime(drone.lastSeen)}</td>
                      <td>
                        <span className="badge badge--inline">
                          {drone.mac ? 'RID/RF' : 'ADS-B'}
                        </span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="control-chip control-chip--ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelect(drone.id, { focus: true });
                          }}
                        >
                          Focus
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

function formatRelativeTime(value: string, mode: 'default' | 'short' = 'default'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }
  const diffSeconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (diffSeconds < 60) {
    return mode === 'short' ? `${diffSeconds}s ago` : `a few seconds ago`;
  }
  if (diffSeconds < 3600) {
    const minutes = Math.floor(diffSeconds / 60);
    return mode === 'short' ? `${minutes}m ago` : `${minutes} minute(s) ago`;
  }
  const hours = Math.floor(diffSeconds / 3600);
  return mode === 'short' ? `${hours}h ago` : `${hours} hour(s) ago`;
}

function formatDroneStatusLabel(status: DroneStatus): string {
  switch (status) {
    case 'FRIENDLY':
      return 'Friendly';
    case 'NEUTRAL':
      return 'Neutral';
    case 'HOSTILE':
      return 'Hostile';
    case 'UNKNOWN':
    default:
      return 'Unknown';
  }
}

function formatDroneStatusClass(status: DroneStatus): string {
  return String(status ?? 'UNKNOWN').toLowerCase();
}

function formatHeading(drone: DroneMarker): string {
  if (
    typeof drone.operatorLat !== 'number' ||
    typeof drone.operatorLon !== 'number' ||
    Number.isNaN(drone.operatorLat) ||
    Number.isNaN(drone.operatorLon)
  ) {
    return 'Unknown';
  }
  const bearing = calculateBearing(drone.operatorLat, drone.operatorLon, drone.lat, drone.lon);
  if (bearing == null) {
    return 'Unknown';
  }
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const index = Math.round(bearing / 45) % directions.length;
  return `${directions[index]} (${bearing.toFixed(0)}°)`;
}

function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number | null {
  if ([lat1, lon1, lat2, lon2].some((value) => Number.isNaN(value))) {
    return null;
  }
  const toRadians = (deg: number) => (deg * Math.PI) / 180;
  const toDegrees = (rad: number) => (rad * 180) / Math.PI;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaLambda = toRadians(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  const bearing = (toDegrees(theta) + 360) % 360;
  return bearing;
}

function renderRidInfo(summary?: FaaAircraftSummary | null) {
  if (!summary) {
    return 'No match';
  }
  const primary =
    summary.makeName || summary.modelName
      ? [summary.makeName, summary.modelName].filter(Boolean).join(' ')
      : (summary.registrantName ??
        summary.nNumber ??
        summary.serialNumber ??
        summary.trackingNumber ??
        'Match');
  const fccLabel = summary.fccIdentifier ?? summary.series ?? null;
  const ridLabel = summary.trackingNumber ?? summary.documentNumber ?? summary.serialNumber ?? null;
  return (
    <div className="rid-cell">
      <div>{primary}</div>
      {fccLabel ? <div className="muted">FCC: {fccLabel}</div> : null}
      {ridLabel ? (
        summary.documentUrl ? (
          <a href={summary.documentUrl} target="_blank" rel="noreferrer">
            {ridLabel}
          </a>
        ) : (
          <div className="muted">{ridLabel}</div>
        )
      ) : null}
    </div>
  );
}
