import classNames from 'clsx';
import { useMemo } from 'react';

import type { AdsbTrack } from '../api/types';
import { detectAdsbAircraftType } from './map/CommandCenterMap';

interface AdsbFloatingCardProps {
  tracks: AdsbTrack[];
  activeId: string | null;
  visible: boolean;
  onClose: () => void;
  onSelect: (track: AdsbTrack, options?: { focus?: boolean }) => void;
}

export function AdsbFloatingCard({
  tracks,
  activeId,
  visible,
  onClose,
  onSelect,
}: AdsbFloatingCardProps) {
  const sorted = useMemo(
    () =>
      [...tracks].sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()),
    [tracks],
  );

  const freshest = sorted[0];
  const routeLabel = (track: AdsbTrack) => {
    const dep = buildAirportLabel(track.depIata, track.depIcao ?? track.dep);
    const dest = buildAirportLabel(track.destIata, track.destIcao ?? track.dest);
    if (dep && dest) return dep === dest ? dep : `${dep} -> ${dest}`;
    return dep || dest || 'Unknown';
  };
  const airportNames = (track: AdsbTrack) => {
    const dep = buildAirportName(track.depAirport, track.depIata, track.depIcao ?? track.dep);
    const dest = buildAirportName(track.destAirport, track.destIata, track.destIcao ?? track.dest);
    if (dep && dest) return dep === dest ? dep : `${dep} -> ${dest}`;
    return dep || dest || null;
  };

  if (sorted.length === 0) {
    return null;
  }

  return (
    <section
      className={classNames('drone-floating-card', { 'drone-floating-card--visible': visible })}
      aria-live="polite"
    >
      <header className="drone-floating-card__header">
        <div>
          <h3>ADS-B Tracks</h3>
          <p className="muted">
            {sorted.length} aircraft / Updated{' '}
            {freshest ? formatRelativeTime(freshest.lastSeen, 'short') : 'unknown'}
          </p>
        </div>
        <button type="button" className="control-chip control-chip--ghost" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="drone-floating-card__body">
        <div className="drone-floating-card__table-wrapper drone-floating-card__table-wrapper--wide adsb-floating-card__table-wrapper">
          <table className="drone-floating-card__table drone-floating-card__table--wide">
            <thead>
              <tr>
                <th>Callsign</th>
                <th>ICAO</th>
                <th>Route</th>
                <th>Airports</th>
                <th>Times</th>
                <th>Reg</th>
                <th>Country</th>
                <th>Type</th>
                <th>Airframe</th>
                <th>Alt</th>
                <th>Speed</th>
                <th>Heading</th>
                <th>Msgs</th>
                <th>Last Seen</th>
                <th>Source</th>
                <th>Focus</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((track, index) => {
                const isActive = activeId === track.id;
                const isMostRecent = index === 0;
                const typeInfo = detectAdsbAircraftType(
                  track.category,
                  track.aircraftType,
                  track.typeCode,
                  track.categoryDescription,
                  track.callsign,
                  track.reg,
                  track.icao,
                  track.manufacturer,
                  track.model,
                );
                return (
                  <tr
                    key={track.id}
                    className={classNames({
                      'is-active': isActive,
                      'is-most-recent': isMostRecent
                    })}
                    onClick={() => onSelect(track)}
                  >
                    <td>
                      <strong>{track.callsign ?? track.icao}</strong>
                      <div className="muted">{track.typeCode ?? track.aircraftType ?? '--'}</div>
                    </td>
                    <td>{track.icao}</td>
                    <td>{routeLabel(track)}</td>
                    <td>{airportNames(track) ?? '--'}</td>
                    <td>
                      <div className="muted">
                        Dep: {track.depTime ? new Date(track.depTime).toLocaleTimeString() : '--'}{' '}
                        {formatDistance(track.depDistanceM)}
                        {track.depCandidates ? ` + ${track.depCandidates} match` : ''}
                      </div>
                      <div className="muted">
                        Arr: {track.destTime ? new Date(track.destTime).toLocaleTimeString() : '--'}{' '}
                        {formatDistance(track.destDistanceM)}
                        {track.destCandidates ? ` + ${track.destCandidates} match` : ''}
                      </div>
                    </td>
                    <td>{track.reg ?? '--'}</td>
                    <td>
                      {track.country ?? '--'}{' '}
                      {typeInfo.isMilitary ? <span title="Military aircraft">★</span> : ''}
                    </td>
                    <td>{track.category ?? track.categoryDescription ?? '--'}</td>
                    <td>
                      {track.model ?? track.aircraftType ?? track.typeCode ?? '--'}
                      <div className="muted">{track.manufacturer ?? ''}</div>
                    </td>
                    <td>{formatNumber(track.alt)}</td>
                    <td>{formatNumber(track.speed)}</td>
                    <td>{formatNumber(track.heading)}</td>
                    <td>{track.messages ?? '--'}</td>
                    <td>{formatRelativeTime(track.lastSeen)}</td>
                    <td>{track.routeSource ?? 'feed'}</td>
                    <td>
                      <button
                        type="button"
                        className="control-chip control-chip--ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(track, { focus: true });
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
    </section>
  );
}

function formatNumber(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '--';
  }
  return value.toFixed(0);
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

function buildAirportLabel(iata?: string | null, icao?: string | null): string | null {
  const iataCode = iata?.trim();
  const icaoCode = icao?.trim();
  if (iataCode && icaoCode && iataCode !== icaoCode) {
    return `${iataCode} (${icaoCode})`;
  }
  return iataCode || icaoCode || null;
}

function buildAirportName(
  name?: string | null,
  iata?: string | null,
  icao?: string | null,
): string | null {
  const label = buildAirportLabel(iata, icao);
  if (name && label) return `${name} (${label})`;
  return name || label || null;
}

function formatDistance(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '';
  }
  return `${value.toFixed(0)} m`;
}
