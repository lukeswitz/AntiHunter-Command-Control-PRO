import classNames from 'clsx';
import type { LatLngExpression, LatLngTuple, Map as LeafletMap, TileLayerOptions } from 'leaflet';
import { DivIcon, divIcon } from 'leaflet';
import * as L from 'leaflet';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import {
  Circle,
  LayersControl,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import 'leaflet.heat';

import type { Geofence, GeofenceVertex, DroneStatus } from '../../api/types';
import controllerMarkerIcon from '../../assets/drone-controller.svg';
import droneMarkerIcon from '../../assets/drone-marker.svg';
import type { AlertColorConfig } from '../../constants/alert-colors';
import type { DroneMarker, DroneTrailPoint } from '../../stores/drone-store';
import { canonicalNodeId, type NodeHistoryPoint, type NodeSummary } from '../../stores/node-store';
import type { TargetMarker } from '../../stores/target-store';
import type { TrackingEstimate } from '../../stores/tracking-session-store';

const FALLBACK_CENTER: LatLngExpression = [0, 0];
const FALLBACK_ZOOM = 2;
const DEFAULT_RADIUS_FALLBACK = 50;
const COVERAGE_MULTIPLIER = 5;
type HeatPoint = [number, number, number];
type BaseLayerDefinition = {
  key: string;
  name: string;
  url: string;
  attribution: string;
  tileOptions?: TileLayerOptions;
};

const BASE_LAYERS: BaseLayerDefinition[] = [
  {
    key: 'osm',
    name: 'Street (OpenStreetMap)',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  {
    key: 'satellite',
    name: 'Satellite (Esri)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    tileOptions: { maxZoom: 19 },
  },
  {
    key: 'topography',
    name: 'Topography (OpenTopo)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution:
      'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap (CC-BY-SA)',
    tileOptions: { maxZoom: 17 },
  },
  {
    key: 'dark',
    name: 'Dark (Carto)',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    tileOptions: { maxZoom: 19 },
  },
];

export type IndicatorSeverity = 'idle' | 'info' | 'notice' | 'alert' | 'critical';

const DRONE_STATUS_LABELS: Record<DroneStatus, string> = {
  UNKNOWN: 'Unknown',
  FRIENDLY: 'Friendly',
  NEUTRAL: 'Neutral',
  HOSTILE: 'Hostile',
};

const DRONE_STATUS_COLORS: Record<DroneStatus, string> = {
  UNKNOWN: '#2563eb',
  FRIENDLY: '#10b981',
  NEUTRAL: '#facc15',
  HOSTILE: '#ef4444',
};

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

function hexToRgb(hex: string): string {
  const normalized = hex.replace('#', '');
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized.padEnd(6, '0');
  const value = Number.parseInt(expanded, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `${r}, ${g}, ${b}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasValidPosition(lat: unknown, lon: unknown): boolean {
  return isFiniteNumber(lat) && isFiniteNumber(lon) && !(lat === 0 && lon === 0);
}

function createNodeIcon(
  node: NodeSummary,
  severity: IndicatorSeverity,
  colors: AlertColorConfig,
): DivIcon {
  const wrapperClasses = ['node-marker-wrapper', `node-marker-wrapper--${severity}`];
  const markerClasses = ['node-marker', `node-marker--${severity}`];
  const label = formatNodeLabel(node);
  const severityColor =
    severity === 'idle'
      ? (node.siteColor ?? colors.idle)
      : severity === 'info'
        ? colors.info
        : severity === 'notice'
          ? colors.notice
          : severity === 'alert'
            ? colors.alert
            : colors.critical;
  const styleAttr = `style="background:${severityColor};--marker-glow-color:${severityColor};"`;
  return divIcon({
    html: `<div class="${markerClasses.join(' ')}" ${styleAttr}>${label}</div>`,
    className: wrapperClasses.join(' '),
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function createTargetIcon(target: TargetMarker): DivIcon {
  const label = target.mac ?? target.id;
  const trackingClass = target.tracking ? ' target-marker--tracking' : '';
  return divIcon({
    html: `<div class="target-marker${trackingClass}"><span>${label}</span></div>`,
    className: 'target-marker-wrapper',
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function createDroneIcon(drone: DroneMarker): DivIcon {
  const label = drone.droneId ?? drone.id;
  const statusKey = formatDroneStatusClass(drone.status);
  const wrapperClasses = ['drone-marker-wrapper', `drone-marker-wrapper--${statusKey}`];
  const markerClasses = ['drone-marker', `drone-marker--${statusKey}`];
  const accent = getDroneStatusColor(drone.status);
  const safeLabel = escapeHtml(label);
  const accentRgb = hexToRgb(drone.status ? accent : '#69F0AE');
  const html = `<div class="${markerClasses.join(
    ' ',
  )}" style="--drone-marker-accent:${accent};--drone-marker-accent-rgb:${accentRgb};"><img src="${droneMarkerIcon}" alt="" class="drone-marker__icon" /><span class="drone-marker__label">${safeLabel}</span></div>`;
  return divIcon({
    html,
    className: wrapperClasses.join(' '),
    iconSize: [64, 78],
    iconAnchor: [32, 32],
  });
}

function createOperatorIcon(drone: DroneMarker): DivIcon {
  const statusKey = formatDroneStatusClass(drone.status);
  const wrapperClasses = ['drone-operator-wrapper', `drone-operator-wrapper--${statusKey}`];
  const markerClasses = ['drone-operator-marker', `drone-operator-marker--${statusKey}`];
  const accent = getDroneStatusColor(drone.status);
  const accentRgb = hexToRgb(accent);
  return divIcon({
    html: `<div class="${markerClasses.join(
      ' ',
    )}" style="--drone-operator-accent:${accent};--drone-operator-accent-rgb:${accentRgb};"><img src="${controllerMarkerIcon}" alt="" class="drone-operator-marker__icon" /><span class="drone-operator-marker__label">OP</span></div>`,
    className: wrapperClasses.join(' '),
    iconSize: [52, 64],
    iconAnchor: [26, 30],
  });
}

function formatNodeLabel(node: NodeSummary): string {
  const siteCode = deriveSiteCode(node.siteName, node.siteId);
  const rawBase = node.name ?? node.id;
  const segments = rawBase
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const token = segments.length > 0 ? segments[segments.length - 1] : rawBase;
  const base = token.replace(/^NODE[_-]?/i, '').toUpperCase();
  return siteCode ? `${siteCode}:${base}` : base;
}

function deriveSiteCode(siteName?: string | null, siteId?: string | null): string | null {
  const candidate = (siteName ?? siteId ?? '').trim();
  if (!candidate) {
    return null;
  }

  const normalized = candidate
    .replace(/[^A-Za-z0-9\s_-]/g, ' ')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((token) => token[0])
    .join('')
    .toUpperCase();

  if (normalized.length >= 2) {
    return normalized.slice(0, 3);
  }

  const fallback = candidate.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (fallback.length >= 2) {
    return fallback.slice(0, 2);
  }

  return candidate.toUpperCase().slice(0, 2);
}

function nodeKey(nodeId: string, siteId?: string | null): string {
  return `${siteId ?? 'default'}::${canonicalNodeId(nodeId)}`;
}

type CircleVisual = {
  className: string;
  stroke: string;
  fill: string;
  fillOpacity: number;
  weight: number;
};

const SEVERITY_PRESET: Record<
  IndicatorSeverity,
  { colorKey: keyof AlertColorConfig; fillOpacity: number; weight: number }
> = {
  idle: { colorKey: 'idle', fillOpacity: 0.25, weight: 2 },
  info: { colorKey: 'info', fillOpacity: 0.3, weight: 2 },
  notice: { colorKey: 'notice', fillOpacity: 0.35, weight: 2 },
  alert: { colorKey: 'alert', fillOpacity: 0.4, weight: 2 },
  critical: { colorKey: 'critical', fillOpacity: 0.45, weight: 3 },
};

function resolveRadiusStyle(severity: IndicatorSeverity, colors: AlertColorConfig): CircleVisual {
  const preset = SEVERITY_PRESET[severity] ?? SEVERITY_PRESET.idle;
  const stroke = colors[preset.colorKey];
  return {
    className: `node-radius node-radius--${severity}`,
    stroke,
    fill: withAlpha(stroke, preset.fillOpacity),
    fillOpacity: preset.fillOpacity,
    weight: preset.weight,
  };
}

function withAlpha(color: string, alpha: number): string {
  if (!color) {
    return color;
  }
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    const normalized =
      hex.length === 3
        ? hex
            .split('')
            .map((ch) => ch + ch)
            .join('')
        : hex;
    const numeric = Number.parseInt(normalized, 16);
    if (Number.isNaN(numeric)) {
      return color;
    }
    const r = (numeric >> 16) & 0xff;
    const g = (numeric >> 8) & 0xff;
    const b = numeric & 0xff;
    const clamped = Math.max(0, Math.min(1, alpha));
    return `rgba(${r}, ${g}, ${b}, ${clamped.toFixed(2)})`;
  }
  if (color.startsWith('rgba')) {
    const match = /^rgba\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d*(?:\.\d+)?)\)$/.exec(color);
    if (match) {
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const clamped = Math.max(0, Math.min(1, alpha));
      return `rgba(${r}, ${g}, ${b}, ${clamped.toFixed(2)})`;
    }
    return color;
  }
  if (color.startsWith('rgb(')) {
    const match = /^rgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)$/.exec(color);
    if (match) {
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const clamped = Math.max(0, Math.min(1, alpha));
      return `rgba(${r}, ${g}, ${b}, ${clamped.toFixed(2)})`;
    }
    return color;
  }
  return color;
}

const trackingEstimateIcon = divIcon({
  className: 'tracking-marker',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  html: '<span class="tracking-marker__pulse"></span>',
});

interface CommandCenterMapProps {
  nodes: NodeSummary[];
  trails: Record<string, NodeHistoryPoint[]>;
  targets: TargetMarker[];
  drones: DroneMarker[];
  droneTrails: Record<string, DroneTrailPoint[]>;
  alertIndicators: Map<string, IndicatorSeverity>;
  alertColors: AlertColorConfig;
  defaultRadius: number;
  showRadius: boolean;
  showTrails: boolean;
  showTargets: boolean;
  followEnabled: boolean;
  showCoverage: boolean;
  geofences: Geofence[];
  geofenceHighlights: Record<string, number>;
  mapStyle: string;
  drawing?: {
    enabled: boolean;
    points: GeofenceVertex[];
    hover?: GeofenceVertex | null;
    onPoint: (vertex: GeofenceVertex) => void;
    onHover: (vertex: GeofenceVertex | null) => void;
  };
  onReady?: (map: LeafletMap) => void;
  onMapStyleChange?: (style: string) => void;
  onDroneSelect?: (droneId: string) => void;
  trackingOverlays?: TrackingEstimate[];
}

export function CommandCenterMap({
  nodes,
  trails,
  targets,
  drones,
  droneTrails,
  alertIndicators,
  alertColors,
  defaultRadius,
  showRadius,
  showTrails,
  showTargets,
  followEnabled,
  showCoverage,
  geofences,
  geofenceHighlights: _geofenceHighlights,
  mapStyle,
  drawing,
  onReady,
  onMapStyleChange,
  onDroneSelect,
  trackingOverlays = [],
}: CommandCenterMapProps) {
  const mapRef = useRef<LeafletMap | null>(null);
  const baseLayerKeys = useMemo(() => BASE_LAYERS.map((layer) => layer.key), []);
  const activeBaseLayerKey = useMemo(() => {
    if (baseLayerKeys.includes(mapStyle)) {
      return mapStyle;
    }
    return BASE_LAYERS[0]?.key ?? 'osm';
  }, [baseLayerKeys, mapStyle]);

  const geofenceHighlights = useMemo(() => {
    const active = new Set<string>();
    Object.entries(_geofenceHighlights ?? {}).forEach(([id, expires]) => {
      if (typeof expires === 'number' && expires > Date.now()) {
        active.add(id);
      }
    });
    return active;
  }, [_geofenceHighlights]);

  useEffect(() => {
    if (mapStyle !== activeBaseLayerKey && onMapStyleChange) {
      onMapStyleChange(activeBaseLayerKey);
    }
  }, [mapStyle, activeBaseLayerKey, onMapStyleChange]);

  const effectiveRadius = useMemo(
    () => Math.max(25, Number.isFinite(defaultRadius) ? defaultRadius : DEFAULT_RADIUS_FALLBACK),
    [defaultRadius],
  );

  const nodesWithPosition = useMemo(
    () => nodes.filter((node) => hasValidPosition(node.lat, node.lon)),
    [nodes],
  );
  const dronesWithPosition = useMemo(
    () => drones.filter((drone) => hasValidPosition(drone.lat, drone.lon)),
    [drones],
  );
  const targetsWithPosition = useMemo(
    () => targets.filter((target) => hasValidPosition(target.lat, target.lon)),
    [targets],
  );

  const center = useMemo<LatLngExpression>(() => {
    const average = <T extends { lat: number; lon: number }>(
      items: T[],
    ): LatLngExpression | null => {
      if (!items.length) {
        return null;
      }
      const latSum = items.reduce((acc, item) => acc + item.lat, 0);
      const lonSum = items.reduce((acc, item) => acc + item.lon, 0);
      return [latSum / items.length, lonSum / items.length];
    };

    return (
      average(nodesWithPosition) ??
      average(dronesWithPosition) ??
      average(targetsWithPosition) ??
      FALLBACK_CENTER
    );
  }, [nodesWithPosition, dronesWithPosition, targetsWithPosition]);

  useEffect(() => {
    if (mapRef.current && nodesWithPosition.length > 0 && followEnabled) {
      const target = nodesWithPosition[0];
      mapRef.current.panTo([target.lat, target.lon]);
    }
  }, [followEnabled, nodesWithPosition]);

  const handleReady = (map: LeafletMap) => {
    mapRef.current = map;
    onReady?.(map);
  };

  const draftPositions = useMemo<LatLngExpression[]>(() => {
    if (!drawing?.enabled || drawing.points.length === 0) {
      return [];
    }
    const base = drawing.points.map((point) => [point.lat, point.lon] as LatLngTuple);
    if (drawing.hover) {
      base.push([drawing.hover.lat, drawing.hover.lon]);
    }
    return base;
  }, [drawing]);

  return (
    <MapContainer
      center={center}
      zoom={
        nodesWithPosition.length || dronesWithPosition.length || targetsWithPosition.length
          ? 13
          : FALLBACK_ZOOM
      }
      className="map-container"
      scrollWheelZoom
      preferCanvas
    >
      <MapReadyBridge onReady={handleReady} />
      <GeofenceDrawingHandler
        enabled={Boolean(drawing?.enabled)}
        onPoint={drawing?.onPoint}
        onHover={drawing?.onHover}
      />
      <LayersControl position="topright">
        {BASE_LAYERS.map((layer) => (
          <LayersControl.BaseLayer
            key={layer.key}
            checked={layer.key === activeBaseLayerKey}
            name={layer.name}
          >
            <TileLayer
              attribution={layer.attribution}
              url={layer.url}
              {...(layer.tileOptions ?? {})}
            />
          </LayersControl.BaseLayer>
        ))}
      </LayersControl>
      <BaseLayerChangeListener onChange={onMapStyleChange} />

      <CoverageHeatLayer enabled={showCoverage} nodes={nodes} baseRadius={effectiveRadius} />

      {geofences.map((geofence) => {
        if (geofence.polygon.length < 3) {
          return null;
        }
        const positions = geofence.polygon.map((vertex: GeofenceVertex) => [
          vertex.lat,
          vertex.lon,
        ]) as LatLngTuple[];
        const highlighted = geofenceHighlights.has(geofence.id);
        const polygonClass = classNames(
          'geofence-polygon',
          highlighted && 'geofence-polygon--breached',
        );
        return (
          <Polygon
            key={geofence.id}
            positions={positions}
            pathOptions={{
              className: polygonClass,
              color: geofence.color,
              fillColor: geofence.color,
              weight: highlighted ? 3 : 2,
              fillOpacity: highlighted ? 0.25 : 0.15,
            }}
          >
            <Tooltip direction="center" opacity={0.85}>
              <div className="geofence-tooltip">
                <strong>{geofence.name}</strong>
                {geofence.alarm.enabled ? (
                  <span className="badge badge--active">Alarm: {geofence.alarm.level}</span>
                ) : (
                  <span className="badge">Alarm disabled</span>
                )}
              </div>
            </Tooltip>
          </Polygon>
        );
      })}

      {drawing?.enabled && draftPositions.length > 0 ? (
        <>
          <Polyline
            positions={draftPositions}
            pathOptions={{ color: '#f97316', dashArray: '6 4', weight: 2 }}
          />
          {draftPositions.length >= 3 ? (
            <Polygon
              positions={draftPositions as LatLngTuple[]}
              pathOptions={{ color: '#f97316', weight: 1, fillOpacity: 0.1, dashArray: '8 6' }}
            />
          ) : null}
        </>
      ) : null}

      {showTrails &&
        nodes.map((node) => {
          const history = trails[node.id] ?? [];
          if (history.length < 2) {
            return null;
          }

          const positions = history.map((point) => [point.lat, point.lon]) as LatLngExpression[];
          return (
            <Polyline
              key={`${nodeKey(node.id, node.siteId)}-trail`}
              positions={positions}
              pathOptions={{ color: '#3b82f6', weight: 3, opacity: 0.6 }}
            />
          );
        })}

      {nodes.map((node) => {
        const siteScopedKey = nodeKey(node.id, node.siteId);
        const indicator =
          alertIndicators.get(siteScopedKey) ??
          alertIndicators.get(nodeKey(node.id, undefined)) ??
          'idle';
        const position: LatLngExpression = [node.lat, node.lon];
        const radiusStyle = resolveRadiusStyle(indicator, alertColors);
        return (
          <Marker
            key={siteScopedKey}
            position={position}
            icon={createNodeIcon(node, indicator, alertColors)}
          >
            <Tooltip direction="top" offset={[0, -12]} opacity={0.9}>
              <div className="node-tooltip">
                <strong>{formatNodeLabel(node)}</strong>
                {node.siteName || node.siteId ? (
                  <div className="muted">{node.siteName ?? node.siteId}</div>
                ) : null}
                <div>
                  Last seen: {node.lastSeen ? new Date(node.lastSeen).toLocaleString() : 'N/A'}
                </div>
                {node.lastMessage && <div>Last message: {node.lastMessage}</div>}
              </div>
            </Tooltip>

            {showRadius ? (
              <Circle
                center={position}
                radius={effectiveRadius}
                pathOptions={{
                  className: radiusStyle.className,
                  color: radiusStyle.stroke,
                  opacity: 0.9,
                  fillColor: radiusStyle.fill,
                  fillOpacity: radiusStyle.fillOpacity,
                  weight: radiusStyle.weight,
                }}
              />
            ) : null}
          </Marker>
        );
      })}

      {showTargets &&
        targets.map((target) => {
          const position: LatLngExpression = [target.lat, target.lon];
          const historyPositions =
            target.history?.map((point) => [point.lat, point.lon] as LatLngTuple) ?? [];
          const hasTrail = historyPositions.length > 1;
          return (
            <Fragment key={target.id}>
              {hasTrail ? (
                <Polyline
                  positions={historyPositions}
                  pathOptions={{
                    color: '#ef4444',
                    weight: target.tracking ? 3 : 2,
                    opacity: target.tracking ? 0.8 : 0.5,
                  }}
                />
              ) : null}
              <Marker position={position} icon={createTargetIcon(target)}>
                <Tooltip direction="top" offset={[0, -10]} opacity={0.95}>
                  <div className="target-tooltip">
                    <strong>{target.mac ?? target.id}</strong>
                    {target.deviceType && <div>Type: {target.deviceType}</div>}
                    <div>Last seen: {new Date(target.lastSeen).toLocaleString()}</div>
                    {target.nodeId && <div>First node: {target.nodeId}</div>}
                    <div>
                      Location: {target.lat.toFixed(5)}, {target.lon.toFixed(5)}
                    </div>
                    {target.tracking ? (
                      <div className="tracking-label">Tracking in progress</div>
                    ) : null}
                    {target.comment ? (
                      <div className="target-comment">Comment: {target.comment}</div>
                    ) : null}
                  </div>
                </Tooltip>
              </Marker>
            </Fragment>
          );
        })}
      {trackingOverlays.map((overlay) => {
        const contributorLines =
          overlay.contributors?.filter(
            (contributor) => Number.isFinite(contributor.lat) && Number.isFinite(contributor.lon),
          ) ?? [];
        return (
          <Fragment key={`tracking-${overlay.targetId}`}>
            {contributorLines.map((contributor, index) => (
              <Polyline
                key={`tracking-link-${overlay.targetId}-${contributor.nodeId ?? index}`}
                positions={[
                  [contributor.lat, contributor.lon],
                  [overlay.lat, overlay.lon],
                ]}
                pathOptions={{
                  color: '#c084fc',
                  weight: 2,
                  opacity: 0.75,
                  dashArray: '6, 10',
                }}
              />
            ))}
            <Marker position={[overlay.lat, overlay.lon]} icon={trackingEstimateIcon}>
              <Tooltip direction="top" offset={[0, -10]} opacity={0.95}>
                <div className="tracking-tooltip">
                  <strong>{overlay.label ?? overlay.mac}</strong>
                  <div>Tracking estimate</div>
                  <div>
                    Position: {overlay.lat.toFixed(5)}, {overlay.lon.toFixed(5)}
                  </div>
                  <div>Confidence: {(overlay.confidence * 100).toFixed(0)}%</div>
                </div>
              </Tooltip>
            </Marker>
          </Fragment>
        );
      })}

      {drones.map((drone) => {
        const dronePosition: LatLngExpression = [drone.lat, drone.lon];
        const trailPoints = droneTrails[drone.id] ?? [];
        const trailPositions =
          trailPoints.length > 1
            ? (trailPoints.map((point) => [point.lat, point.lon]) as LatLngTuple[])
            : null;
        const heading = computeHeadingFromTrail(trailPoints);
        const viewCone =
          heading !== null ? buildViewCone(drone.lat, drone.lon, heading, 500, 20) : null;
        const hasOperator =
          typeof drone.operatorLat === 'number' &&
          Number.isFinite(drone.operatorLat) &&
          typeof drone.operatorLon === 'number' &&
          Number.isFinite(drone.operatorLon);
        const operatorPosition: LatLngExpression | null = hasOperator
          ? [drone.operatorLat!, drone.operatorLon!]
          : null;

        return (
          <Fragment key={`drone-${drone.id}`}>
            {trailPositions ? (
              <Polyline
                positions={trailPositions}
                pathOptions={{
                  color: getDroneStatusColor(drone.status),
                  weight: 2,
                  opacity: 0.5,
                }}
              />
            ) : null}
            {viewCone ? (
              <Polygon
                positions={viewCone}
                pathOptions={{
                  color: getDroneStatusColor(drone.status),
                  weight: 1,
                  opacity: 0.65,
                  fillOpacity: 0.15,
                }}
              />
            ) : null}
            {hasOperator && operatorPosition ? (
              <>
                <Polyline
                  positions={[dronePosition, operatorPosition]}
                  pathOptions={{
                    color: getDroneStatusColor(drone.status),
                    weight: 2,
                    opacity: 0.75,
                    dashArray: '8, 12',
                  }}
                />
                <Marker
                  position={operatorPosition}
                  icon={createOperatorIcon(drone)}
                  eventHandlers={{
                    click: () => onDroneSelect?.(drone.id),
                  }}
                >
                  <Tooltip
                    direction="top"
                    offset={[0, -10]}
                    opacity={0.95}
                    className="tooltip--drone tooltip--drone-operator"
                  >
                    <div className="drone-operator-tooltip">
                      <strong>Drone Operator</strong>
                      {drone.faa?.makeName || drone.faa?.modelName ? (
                        <div>
                          Craft:{' '}
                          {[drone.faa.makeName, drone.faa.modelName].filter(Boolean).join(' ')}
                        </div>
                      ) : null}
                      {drone.faa?.registrantName ? (
                        <div>Operator: {drone.faa.registrantName}</div>
                      ) : null}
                      {drone.faa?.fccIdentifier ? <div>FCC: {drone.faa.fccIdentifier}</div> : null}
                      {drone.faa?.trackingNumber || drone.faa?.documentNumber ? (
                        <div>
                          RID:{' '}
                          {drone.faa.documentUrl ? (
                            <a href={drone.faa.documentUrl} target="_blank" rel="noreferrer">
                              {drone.faa.trackingNumber ?? drone.faa.documentNumber}
                            </a>
                          ) : (
                            (drone.faa.trackingNumber ?? drone.faa.documentNumber)
                          )}
                        </div>
                      ) : null}
                      <div>Drone ID: {drone.droneId ?? drone.id}</div>
                      {drone.mac && <div>MAC: {drone.mac}</div>}
                      <div>
                        Location: {drone.operatorLat!.toFixed(6)}, {drone.operatorLon!.toFixed(6)}
                      </div>
                    </div>
                  </Tooltip>
                </Marker>
              </>
            ) : null}
            <Marker
              position={dronePosition}
              icon={createDroneIcon(drone)}
              eventHandlers={{
                click: () => onDroneSelect?.(drone.id),
              }}
            >
              <Tooltip direction="top" offset={[0, -10]} opacity={0.95} className="tooltip--drone">
                <div className="drone-tooltip">
                  <strong>Drone {drone.droneId ?? drone.id}</strong>
                  {drone.faa?.makeName || drone.faa?.modelName ? (
                    <div>
                      Craft: {[drone.faa.makeName, drone.faa.modelName].filter(Boolean).join(' ')}
                    </div>
                  ) : null}
                  <div className="drone-tooltip__status">
                    Status:{' '}
                    <span
                      className={`drone-status-badge drone-status-badge--${formatDroneStatusClass(drone.status)}`}
                    >
                      {formatDroneStatusLabel(drone.status)}
                    </span>
                  </div>
                  {drone.mac && <div>MAC: {drone.mac}</div>}
                  {drone.nodeId && <div>Detected by: {drone.nodeId}</div>}
                  {drone.siteName || drone.siteId ? (
                    <div>Site: {drone.siteName ?? drone.siteId}</div>
                  ) : null}
                  <div>
                    Location: {drone.lat.toFixed(6)}, {drone.lon.toFixed(6)}
                  </div>
                  {typeof drone.altitude === 'number' && Number.isFinite(drone.altitude) ? (
                    <div>Altitude: {drone.altitude.toFixed(1)} m</div>
                  ) : null}
                  {typeof drone.speed === 'number' && Number.isFinite(drone.speed) ? (
                    <div>Speed: {drone.speed.toFixed(1)} m/s</div>
                  ) : null}
                  {typeof drone.rssi === 'number' && Number.isFinite(drone.rssi) ? (
                    <div>RSSI: {drone.rssi} dBm</div>
                  ) : null}
                  {hasOperator && drone.operatorLat != null && drone.operatorLon != null ? (
                    <div>
                      Operator: {drone.operatorLat.toFixed(6)}, {drone.operatorLon.toFixed(6)}
                    </div>
                  ) : null}
                  <div>Last seen: {new Date(drone.lastSeen).toLocaleTimeString()}</div>
                </div>
              </Tooltip>
            </Marker>
          </Fragment>
        );
      })}
    </MapContainer>
  );
}

function computeHeadingFromTrail(points: DroneTrailPoint[]): number | null {
  if (!points || points.length < 2) {
    return null;
  }
  for (let i = points.length - 2; i >= 0; i -= 1) {
    const prev = points[i];
    const last = points[points.length - 1];
    if (!prev) {
      continue;
    }
    if (Math.abs(prev.lat - last.lat) < 1e-6 && Math.abs(prev.lon - last.lon) < 1e-6) {
      continue;
    }
    return bearingBetween(prev.lat, prev.lon, last.lat, last.lon);
  }
  return null;
}

function buildViewCone(
  lat: number,
  lon: number,
  heading: number,
  distanceMeters: number,
  angleDegrees: number,
): LatLngTuple[] | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  const halfAngle = angleDegrees / 2;
  const left = offsetCoordinate(lat, lon, distanceMeters, heading - halfAngle);
  const right = offsetCoordinate(lat, lon, distanceMeters, heading + halfAngle);
  if (!left || !right) {
    return null;
  }
  return [
    [lat, lon],
    [left.lat, left.lon],
    [right.lat, right.lon],
  ];
}

function bearingBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  const deg = (θ * 180) / Math.PI;
  return (deg + 360) % 360;
}

function offsetCoordinate(
  lat: number,
  lon: number,
  distanceMeters: number,
  bearingDegrees: number,
): { lat: number; lon: number } | null {
  const R = 6_371_000;
  const δ = distanceMeters / R;
  const θ = (bearingDegrees * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;

  const sinφ2 = Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const λ2 =
    λ1 +
    Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));

  if (!Number.isFinite(φ2) || !Number.isFinite(λ2)) {
    return null;
  }
  return { lat: (φ2 * 180) / Math.PI, lon: (((λ2 * 180) / Math.PI + 540) % 360) - 180 };
}
function MapReadyBridge({ onReady }: { onReady?: (map: LeafletMap) => void }) {
  const map = useMap();
  const initializedRef = useRef(false);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      onReady?.(map);
    }
  }, [map, onReady]);

  return null;
}

function GeofenceDrawingHandler({
  enabled,
  onPoint,
  onHover,
}: {
  enabled: boolean;
  onPoint?: (vertex: GeofenceVertex) => void;
  onHover?: (vertex: GeofenceVertex | null) => void;
}) {
  useMapEvents({
    click(event) {
      if (!enabled || !onPoint) {
        return;
      }
      onPoint({ lat: event.latlng.lat, lon: event.latlng.lng });
    },
    mousemove(event) {
      if (!enabled || !onHover) {
        return;
      }
      onHover({ lat: event.latlng.lat, lon: event.latlng.lng });
    },
    mouseout() {
      if (!enabled || !onHover) {
        return;
      }
      onHover(null);
    },
  });
  return null;
}

function BaseLayerChangeListener({ onChange }: { onChange?: (style: string) => void }) {
  const map = useMap();

  useEffect(() => {
    if (!onChange) {
      return;
    }
    const handler = (event: L.LayersControlEvent) => {
      const match = BASE_LAYERS.find((layer) => layer.name === event.name);
      if (match) {
        onChange(match.key);
      }
    };
    map.on('baselayerchange', handler);
    return () => {
      map.off('baselayerchange', handler);
    };
  }, [map, onChange]);

  return null;
}

function CoverageHeatLayer({
  enabled,
  nodes,
  baseRadius,
}: {
  enabled: boolean;
  nodes: NodeSummary[];
  baseRadius: number;
}) {
  const map = useMap();
  const layerRef = useRef<L.Layer | null>(null);
  const points = useMemo(
    () => (enabled ? buildCoveragePoints(nodes, baseRadius) : []),
    [enabled, nodes, baseRadius],
  );

  useEffect(() => {
    if (!enabled) {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
      return;
    }

    if (!points.length) {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
      return;
    }

    if (layerRef.current) {
      map.removeLayer(layerRef.current);
      layerRef.current = null;
    }

    const heatFactory = (
      L as unknown as typeof L & {
        heatLayer?: (latlngs: HeatPoint[], options?: L.HeatMapOptions) => L.HeatLayer;
      }
    ).heatLayer;
    if (typeof heatFactory !== 'function') {
      return;
    }
    const heat = heatFactory(points, {
      radius: 45,
      blur: 30,
      maxZoom: 18,
      minOpacity: 0.15,
      gradient: {
        0.0: 'rgba(59,130,246,0.0)',
        0.5: 'rgba(59,130,246,0.35)',
        0.8: 'rgba(59,130,246,0.65)',
        1.0: '#1d4ed8',
      },
    });
    heat.addTo(map);
    layerRef.current = heat;

    return () => {
      if (layerRef.current) {
        map.removeLayer(layerRef.current);
        layerRef.current = null;
      }
    };
  }, [enabled, map, points]);

  return null;
}

function estimateCoverageFactor(node: NodeSummary): number {
  if (node.lastMessage) {
    const altitudeMatch = node.lastMessage.match(/(?:ALT|ALTITUDE)[\s:=]+(-?\d+(?:\.\d+)?)/i);
    if (altitudeMatch) {
      const altitude = Number.parseFloat(altitudeMatch[1]);
      if (Number.isFinite(altitude)) {
        const normalized = 0.5 + altitude / 1500;
        return Math.max(0.35, Math.min(1.7, normalized));
      }
    }
  }
  const seed = node.siteName ?? node.siteId ?? node.id;
  const hash = Array.from(seed).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return 0.8 + ((hash % 60) - 30) / 200;
}

function buildCoveragePoints(nodes: NodeSummary[], baseRadius: number): HeatPoint[] {
  const samples: HeatPoint[] = [];
  nodes.forEach((node) => {
    if (typeof node.lat !== 'number' || typeof node.lon !== 'number') {
      return;
    }
    const factor = estimateCoverageFactor(node);
    const adjustedBase = Math.max(25, baseRadius);
    const coverageRadius = adjustedBase * COVERAGE_MULTIPLIER * factor;
    const latMeters = 111_320;
    const lonMeters = latMeters * Math.cos((node.lat * Math.PI) / 180);

    // center point strongest
    samples.push([node.lat, node.lon, 1]);

    const radialSteps = 5;
    const angleSteps = 24;
    for (let rIndex = 1; rIndex <= radialSteps; rIndex += 1) {
      const radius = (coverageRadius * rIndex) / radialSteps;
      const weight = Math.max(0.05, 1 - rIndex / (radialSteps + 0.5));
      for (let angleIndex = 0; angleIndex < angleSteps; angleIndex += 1) {
        const radians = (angleIndex / angleSteps) * Math.PI * 2;
        const dLat = (radius * Math.cos(radians)) / latMeters;
        const dLon = (radius * Math.sin(radians)) / lonMeters;
        samples.push([node.lat + dLat, node.lon + dLon, weight]);
      }
    }
  });
  return samples;
}

function formatDroneStatusLabel(status: DroneMarker['status']): string {
  return DRONE_STATUS_LABELS[status] ?? 'Unknown';
}

function formatDroneStatusClass(status: DroneMarker['status']): string {
  return String(status ?? 'UNKNOWN').toLowerCase();
}

function getDroneStatusColor(status: DroneMarker['status']): string {
  const key = (status ?? 'UNKNOWN') as DroneStatus;
  return DRONE_STATUS_COLORS[key] ?? DRONE_STATUS_COLORS.UNKNOWN;
}
