import { ChangeEvent, useMemo } from 'react';
import { MdDelete, MdMyLocation, MdWarningAmber } from 'react-icons/md';
import { useNavigate } from 'react-router-dom';

import type { AlarmLevel } from '../api/types';
import { useGeofenceStore } from '../stores/geofence-store';
import { useMapCommandStore } from '../stores/map-command-store';

const ALARM_LEVELS: AlarmLevel[] = ['INFO', 'NOTICE', 'ALERT', 'CRITICAL'];
const HIGHLIGHT_DURATION_MS = 10_000;

export function GeofencePage() {
  const navigate = useNavigate();
  const geofences = useGeofenceStore((state) => state.geofences);
  const updateGeofence = useGeofenceStore((state) => state.updateGeofence);
  const deleteGeofence = useGeofenceStore((state) => state.deleteGeofence);
  const setAlarmEnabled = useGeofenceStore((state) => state.setAlarmEnabled);
  const resetStates = useGeofenceStore((state) => state.resetStates);
  const setHighlighted = useGeofenceStore((state) => state.setHighlighted);
  const goto = useMapCommandStore((state) => state.goto);

  const totalArea = useMemo(() => geofences.length, [geofences]);

  const handleFocus = (geofenceIndex: number) => {
    const geofence = geofences[geofenceIndex];
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

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this geofence? This cannot be undone.')) {
      return;
    }
    deleteGeofence(id);
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

  return (
    <section className="panel geofence-panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Geofences</h1>
          <p className="panel__subtitle">
            {totalArea} geofence{totalArea === 1 ? '' : 's'} configured
          </p>
        </div>
        <p className="panel__subtitle">
          Geofences trigger custom alarms when tracked drones or devices enter or exit defined
          zones. Use the map to draw new boundaries and manage alarm behaviour here.
        </p>
      </header>

      {geofences.length === 0 ? (
        <div className="empty-state">
          <MdWarningAmber size={48} />
          <p>
            No geofences yet. Use the &quot;Create Geofence&quot; button on the map to draw one.
          </p>
        </div>
      ) : (
        <div className="geofence-list">
          {geofences.map((geofence, index) => (
            <article key={geofence.id} className="geofence-card">
              <header className="geofence-card__header">
                <div className="geofence-card__title">
                  <input
                    value={geofence.name}
                    onChange={(event) => handleNameChange(geofence.id, event)}
                    placeholder="Geofence name"
                  />
                  <div className="geofence-meta">
                    <span>{geofence.polygon.length} vertices</span>
                    <span>
                      Created{' '}
                      {new Date(geofence.createdAt).toLocaleString(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </span>
                  </div>
                </div>
                <div className="geofence-card__actions">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={geofence.alarm.enabled}
                      onChange={(event) => setAlarmEnabled(geofence.id, event.target.checked)}
                    />
                    <span>Alarm</span>
                  </label>
                  <button type="button" onClick={() => handleFocus(index)}>
                    <MdMyLocation /> Focus
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => handleDelete(geofence.id)}
                  >
                    <MdDelete /> Delete
                  </button>
                </div>
              </header>

              <div className="geofence-card__body">
                <label>
                  Color
                  <input
                    type="color"
                    value={geofence.color}
                    onChange={(event) => handleColorChange(geofence.id, event)}
                    aria-label={`Color for ${geofence.name}`}
                  />
                </label>
                <label>
                  Alarm level
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
                </label>
                <label className="geofence-card__message">
                  Alarm message{' '}
                  <span className="hint">
                    (use tokens: {'{entity}'}, {'{geofence}'}, {'{type}'}, {'{event}'})
                  </span>
                  <textarea
                    rows={3}
                    value={geofence.alarm.message}
                    onChange={(event) => handleMessageChange(geofence.id, event)}
                    placeholder="Alert text, e.g. {entity} entered geofence {geofence}"
                  />
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={Boolean(geofence.alarm.triggerOnExit)}
                    onChange={(event) => handleTriggerExitChange(geofence.id, event)}
                  />
                  <span>Trigger on exit</span>
                </label>
              </div>
            </article>
          ))}
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
