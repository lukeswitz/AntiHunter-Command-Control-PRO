import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { MdDelete, MdMyLocation, MdWarningAmber } from 'react-icons/md';
import { useNavigate } from 'react-router-dom';

import type { AlarmLevel } from '../api/types';
import { useGeofenceStore } from '../stores/geofence-store';
import { useMapCommandStore } from '../stores/map-command-store';

const ALARM_LEVELS: AlarmLevel[] = ['INFO', 'NOTICE', 'ALERT', 'CRITICAL'];
const HIGHLIGHT_DURATION_MS = 10_000;
type SortKey = 'name' | 'site' | 'vertices' | 'level' | 'enabled';
type SortDirection = 'asc' | 'desc';

export function GeofencePage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const geofences = useGeofenceStore((state) => state.geofences);
  const updateGeofence = useGeofenceStore((state) => state.updateGeofence);
  const deleteGeofence = useGeofenceStore((state) => state.deleteGeofence);
  const loadGeofences = useGeofenceStore((state) => state.loadGeofences);
  const setAlarmEnabled = useGeofenceStore((state) => state.setAlarmEnabled);
  const resetStates = useGeofenceStore((state) => state.resetStates);
  const setHighlighted = useGeofenceStore((state) => state.setHighlighted);
  const goto = useMapCommandStore((state) => state.goto);

  useEffect(() => {
    void loadGeofences();
  }, [loadGeofences]);

  const uniqueGeofences = useMemo(() => {
    const map = new Map<string, (typeof geofences)[number]>();
    geofences.forEach((g) => {
      if (!map.has(g.id)) {
        map.set(g.id, g);
      }
    });
    return Array.from(map.values());
  }, [geofences]);

  const filteredGeofences = useMemo(() => {
    if (!search.trim()) {
      return uniqueGeofences;
    }
    const term = search.trim().toLowerCase();
    return uniqueGeofences.filter((geofence) => {
      const siteLabel = geofence.site?.name ?? geofence.siteId ?? 'local';
      return (
        (geofence.name ?? '').toLowerCase().includes(term) ||
        siteLabel.toLowerCase().includes(term) ||
        (geofence.alarm.message ?? '').toLowerCase().includes(term)
      );
    });
  }, [uniqueGeofences, search]);

  const sortedGeofences = useMemo(() => {
    const multiplier = sortDirection === 'asc' ? 1 : -1;
    return [...filteredGeofences].sort((a, b) => {
      let comparison = 0;
      switch (sortKey) {
        case 'name':
          comparison = compareStrings(a.name, b.name);
          break;
        case 'site':
          comparison = compareStrings(
            a.site?.name ?? a.siteId ?? '',
            b.site?.name ?? b.siteId ?? '',
          );
          break;
        case 'vertices':
          comparison = compareNumbers(a.polygon.length, b.polygon.length);
          break;
        case 'level':
          comparison = compareStrings(a.alarm.level, b.alarm.level);
          break;
        case 'enabled':
          comparison = compareNumbers(a.alarm.enabled ? 1 : 0, b.alarm.enabled ? 1 : 0);
          break;
        default:
          comparison = 0;
      }
      return comparison * multiplier;
    });
  }, [filteredGeofences, sortDirection, sortKey]);

  const totalArea = useMemo(() => sortedGeofences.length, [sortedGeofences]);

  const handleFocus = (geofenceId: string) => {
    const geofence = geofences.find((g) => g.id === geofenceId);
    if (!geofence || geofence.polygon.length === 0) {
      return;
    }
    const centroid = calculatePolygonCentroid(geofence.polygon);
    const bounds = calculatePolygonBounds(geofence.polygon);
    goto({
      lat: centroid.lat,
      lon: centroid.lon,
      zoom: 16,
      geofenceId: geofence.id,
      bounds,
    });
    setHighlighted(geofence.id, HIGHLIGHT_DURATION_MS);
    navigate('/map');
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this geofence? This cannot be undone.')) {
      return;
    }
    await deleteGeofence(id);
    resetStates(id);
  };

  const handleNameChange = (id: string, event: ChangeEvent<HTMLInputElement>) => {
    updateGeofence(id, { name: event.target.value });
  };

  const handleColorChange = (id: string, event: ChangeEvent<HTMLInputElement>) => {
    updateGeofence(id, { color: event.target.value });
  };

  const handleMessageChange = (id: string, event: ChangeEvent<HTMLTextAreaElement>) => {
    updateGeofence(id, {
      alarm: {
        message: event.target.value,
      },
    });
  };

  const handleLevelChange = (id: string, event: ChangeEvent<HTMLSelectElement>) => {
    const level = event.target.value.toUpperCase() as AlarmLevel;
    updateGeofence(id, {
      alarm: {
        level: ALARM_LEVELS.includes(level) ? level : 'ALERT',
      },
    });
  };

  const handleTriggerExitChange = (id: string, event: ChangeEvent<HTMLInputElement>) => {
    updateGeofence(id, {
      alarm: {
        triggerOnExit: event.target.checked,
      },
    });
  };

  const handleSort = (column: SortKey) => {
    if (sortKey === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(column);
      setSortDirection(column === 'vertices' ? 'desc' : 'asc');
    }
  };

  const ariaSort = (column: SortKey): 'none' | 'ascending' | 'descending' =>
    sortKey === column ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';

  const renderSortIcon = (column: SortKey) => {
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
  };

  const renderEmptyState = () => (
    <div className="empty-state">
      <MdWarningAmber size={48} />
      <p>
        No geofences {search.trim() ? 'matching your search. Adjust the filters or' : ''} yet. Use
        the &quot;Create Geofence&quot; button on the map to draw one.
      </p>
    </div>
  );

  return (
    <section className="panel geofence-panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Geofences</h1>
          <p className="panel__subtitle">
            Geofences trigger custom alarms when tracked drones or devices enter or exit defined
            zones. Use the map to draw new boundaries and manage alarm behaviour here.
          </p>
        </div>
        <div className="geofence-header__actions">
          <p className="panel__subtitle">
            {totalArea} geofence{totalArea === 1 ? '' : 's'} configured
          </p>
          <input
            className="control-input"
            placeholder="Search geofences..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </header>

      {filteredGeofences.length === 0 ? (
        renderEmptyState()
      ) : (
        <div className="geofence-table">
          <table>
            <thead>
              <tr>
                <th aria-sort={ariaSort('name')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('name')}>
                    Name & Metadata {renderSortIcon('name')}
                  </button>
                </th>
                <th aria-sort={ariaSort('site')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('site')}>
                    Site {renderSortIcon('site')}
                  </button>
                </th>
                <th aria-sort={ariaSort('vertices')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('vertices')}
                  >
                    Vertices {renderSortIcon('vertices')}
                  </button>
                </th>
                <th>Color</th>
                <th aria-sort={ariaSort('level')}>
                  <button type="button" className="table-sort" onClick={() => handleSort('level')}>
                    Alarm Level {renderSortIcon('level')}
                  </button>
                </th>
                <th aria-sort={ariaSort('enabled')}>
                  <button
                    type="button"
                    className="table-sort"
                    onClick={() => handleSort('enabled')}
                  >
                    Alarm Enabled {renderSortIcon('enabled')}
                  </button>
                </th>
                <th>Trigger Exit</th>
                <th>Alarm Message</th>
                <th>ADS-B</th>
                <th>Drones</th>
                <th>Targets</th>
                <th>Devices</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedGeofences.map((geofence) => (
                <tr key={geofence.id}>
                  <td className="geofence-table__name">
                    <input
                      value={geofence.name}
                      onChange={(event) => handleNameChange(geofence.id, event)}
                      placeholder="Geofence name"
                    />
                    <div className="geofence-meta">
                      <span>
                        Created{' '}
                        {new Date(geofence.createdAt).toLocaleString(undefined, {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </span>
                      <span>ID: {geofence.id}</span>
                    </div>
                  </td>
                  <td>
                    <span className="site-chip">
                      {geofence.site?.name ?? geofence.siteId ?? 'Local'}
                    </span>
                  </td>
                  <td>{geofence.polygon.length}</td>
                  <td>
                    <input
                      type="color"
                      value={geofence.color || '#1d4ed8'}
                      onChange={(event) => handleColorChange(geofence.id, event)}
                      aria-label={`Color for ${geofence.name}`}
                    />
                  </td>
                  <td>
                    <select
                      value={geofence.alarm.level}
                      onChange={(event) => handleLevelChange(geofence.id, event)}
                    >
                      {ALARM_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <label
                      className="switch"
                      aria-label={`Enable alarm notifications for ${geofence.name ?? 'this geofence'}`}
                    >
                      <input
                        type="checkbox"
                        checked={geofence.alarm.enabled}
                        onChange={(event) => setAlarmEnabled(geofence.id, event.target.checked)}
                      />
                      <span />
                    </label>
                  </td>
                  <td>
                    <label
                      className="switch"
                      aria-label={`Trigger exit alarm for ${geofence.name ?? 'this geofence'}`}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(geofence.alarm.triggerOnExit)}
                        onChange={(event) => handleTriggerExitChange(geofence.id, event)}
                      />
                      <span />
                    </label>
                  </td>
                  <td className="geofence-table__message">
                    <textarea
                      rows={2}
                      value={geofence.alarm.message}
                      onChange={(event) => handleMessageChange(geofence.id, event)}
                      placeholder="Alert text, e.g. {entity} entered geofence {geofence}"
                    />
                  </td>
                  <td>
                    <label
                      className="switch"
                      aria-label={`Apply to ADS-B aircraft for ${geofence.name ?? 'this geofence'}`}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(geofence.appliesToAdsb)}
                        onChange={(event) =>
                          updateGeofence(geofence.id, { appliesToAdsb: event.target.checked })
                        }
                      />
                      <span />
                    </label>
                  </td>
                  <td>
                    <label
                      className="switch"
                      aria-label={`Apply to drones for ${geofence.name ?? 'this geofence'}`}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(geofence.appliesToDrones)}
                        onChange={(event) =>
                          updateGeofence(geofence.id, { appliesToDrones: event.target.checked })
                        }
                      />
                      <span />
                    </label>
                  </td>
                  <td>
                    <label
                      className="switch"
                      aria-label={`Apply to targets for ${geofence.name ?? 'this geofence'}`}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(geofence.appliesToTargets)}
                        onChange={(event) =>
                          updateGeofence(geofence.id, { appliesToTargets: event.target.checked })
                        }
                      />
                      <span />
                    </label>
                  </td>
                  <td>
                    <label
                      className="switch"
                      aria-label={`Apply to devices for ${geofence.name ?? 'this geofence'}`}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(geofence.appliesToDevices)}
                        onChange={(event) =>
                          updateGeofence(geofence.id, { appliesToDevices: event.target.checked })
                        }
                      />
                      <span />
                    </label>
                  </td>
                  <td className="geofence-table__actions">
                    <button type="button" onClick={() => handleFocus(geofence.id)}>
                      <MdMyLocation /> Focus
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => handleDelete(geofence.id)}
                    >
                      <MdDelete /> Delete
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

function calculatePolygonCentroid(points: { lat: number; lon: number }[]) {
  if (!points.length) {
    return { lat: 0, lon: 0 };
  }
  let sumLat = 0;
  let sumLon = 0;
  points.forEach((point) => {
    sumLat += point.lat;
    sumLon += point.lon;
  });
  return {
    lat: sumLat / points.length,
    lon: sumLon / points.length,
  };
}

function calculatePolygonBounds(points: { lat: number; lon: number }[]) {
  if (!points.length) {
    return {
      southWest: [0, 0] as [number, number],
      northEast: [0, 0] as [number, number],
    };
  }
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;

  points.forEach((point) => {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
  });

  return {
    southWest: [minLat, minLon] as [number, number],
    northEast: [maxLat, maxLon] as [number, number],
  };
}

function compareStrings(a?: string | null, b?: string | null): number {
  const valueA = (a ?? '').toLowerCase();
  const valueB = (b ?? '').toLowerCase();
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
