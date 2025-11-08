import { useQuery } from '@tanstack/react-query';
import { Map as LeafletMap, latLngBounds } from 'leaflet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MdCenterFocusStrong,
  MdTimeline,
  MdMyLocation,
  MdRadioButtonChecked,
  MdVisibility,
  MdCropFree,
  MdUndo,
  MdCancel,
  MdCheckCircle,
  MdBookmarkAdd,
  MdClose,
} from 'react-icons/md';

import { apiClient } from '../api/client';
import type { AlarmLevel, AppSettings, GeofenceVertex, SiteSummary, Target } from '../api/types';
import { CommandCenterMap, type IndicatorSeverity } from '../components/map/CommandCenterMap';
import { extractAlertColors } from '../constants/alert-colors';
import type { AlertColorConfig } from '../constants/alert-colors';
import { useAlertStore } from '../stores/alert-store';
import { useAuthStore } from '../stores/auth-store';
import { useGeofenceStore } from '../stores/geofence-store';
import { useMapCommandStore } from '../stores/map-command-store';
import { useMapPreferences } from '../stores/map-store';
import { type SavedMapView, useMapViewsStore } from '../stores/map-views-store';
import { canonicalNodeId, useNodeStore } from '../stores/node-store';
import { useTargetStore } from '../stores/target-store';
import type { TargetMarker } from '../stores/target-store';

const GEOFENCE_HIGHLIGHT_MS = 10_000;

export function MapPage() {
  const { nodes, order, histories } = useNodeStore((state) => ({
    nodes: state.nodes,
    order: state.order,
    histories: state.histories,
  }));

  const mapRef = useRef<LeafletMap | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const { commentMap, trackingMap } = useTargetStore((state) => ({
    commentMap: state.commentMap,
    trackingMap: state.trackingMap,
  }));
  const targetsQuery = useQuery({
    queryKey: ['targets'],
    queryFn: async () => apiClient.get<Target[]>('/targets'),
  });
  const alerts = useAlertStore((state) => state.alerts);
  const pendingTarget = useMapCommandStore((state) => state.target);
  const consumeTarget = useMapCommandStore((state) => state.consume);
  const goto = useMapCommandStore((state) => state.goto);

  const savedViews = useMapViewsStore((state) => state.views);
  const addView = useMapViewsStore((state) => state.addView);
  const removeView = useMapViewsStore((state) => state.removeView);

  const [newViewName, setNewViewName] = useState('');
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');

  const authStatus = useAuthStore((state) => state.status);
  const isAuthenticated = authStatus === 'authenticated';

  const appSettingsQuery = useQuery({
    queryKey: ['appSettings'],
    queryFn: () => apiClient.get<AppSettings>('/config/app'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  const geofences = useGeofenceStore((state) => state.geofences);
  const addGeofence = useGeofenceStore((state) => state.addGeofence);
  const loadGeofences = useGeofenceStore((state) => state.loadGeofences);
  const geofenceHighlights = useGeofenceStore((state) => state.highlighted);
  const pruneGeofenceHighlights = useGeofenceStore((state) => state.pruneHighlights);
  const setGeofenceHighlighted = useGeofenceStore((state) => state.setHighlighted);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void loadGeofences();
  }, [isAuthenticated, loadGeofences]);

  const targetMarkers = useMemo<TargetMarker[]>(() => {
    if (!targetsQuery.data) {
      return [];
    }
    return targetsQuery.data.map<TargetMarker>((target) => {
      const trackingEntry = trackingMap[target.id];
      const comment = commentMap[target.id];
      const lastSeen = target.updatedAt ?? target.createdAt;
      return {
        id: target.id,
        mac: target.mac ?? undefined,
        name: target.name ?? undefined,
        nodeId: target.firstNodeId ?? undefined,
        firstNodeId: target.firstNodeId ?? undefined,
        lat: target.lat,
        lon: target.lon,
        lastSeen,
        deviceType: target.deviceType ?? undefined,
        comment,
        tracking: trackingEntry?.active ?? false,
        trackingSince: trackingEntry?.since ?? null,
        trackingConfidence:
          typeof target.trackingConfidence === 'number' ? target.trackingConfidence : undefined,
        history: [
          {
            lat: target.lat,
            lon: target.lon,
            ts: lastSeen,
          },
        ],
      };
    });
  }, [targetsQuery.data, commentMap, trackingMap]);

  const {
    trailsEnabled,
    radiusEnabled,
    followEnabled,
    targetsEnabled,
    coverageEnabled,
    mapStyle,
    toggleTrails,
    toggleRadius,
    toggleFollow,
    toggleTargets,
  } = useMapPreferences();
  const fitEnabled = useMapPreferences((state) => state.fitEnabled);
  const setMapStyle = useMapPreferences((state) => state.setMapStyle);
  const setFitEnabled = useMapPreferences((state) => state.setFitEnabled);

  const nodeList = useMemo(() => order.map((id) => nodes[id]).filter(Boolean), [nodes, order]);

  const onlineCount = useMemo(
    () => nodeList.filter((node) => Boolean(node?.lastSeen)).length,
    [nodeList],
  );

  const alertColors: AlertColorConfig = useMemo(
    () => extractAlertColors(appSettingsQuery.data),
    [appSettingsQuery.data],
  );
  const mapDefaultRadius = appSettingsQuery.data?.defaultRadiusM ?? 100;

  const alertIndicatorMap = useMemo(() => {
    const severityRank: Record<IndicatorSeverity, number> = {
      idle: 0,
      info: 1,
      notice: 2,
      alert: 3,
      critical: 4,
    };
    const applyIndicator = (
      map: Map<string, IndicatorSeverity>,
      key: string,
      indicator: IndicatorSeverity,
    ) => {
      if (indicator === 'idle') {
        return;
      }
      const previous = map.get(key);
      const previousRank = previous ? severityRank[previous] : 0;
      if (severityRank[indicator] >= previousRank) {
        map.set(key, indicator);
      }
    };

    const map = new Map<string, IndicatorSeverity>();
    Object.values(alerts).forEach((alert) => {
      const level = (alert.level ?? 'INFO').toUpperCase();
      let indicator: IndicatorSeverity;
      switch (level) {
        case 'INFO':
          indicator = 'info';
          break;
        case 'NOTICE':
          indicator = 'notice';
          break;
        case 'ALERT':
          indicator = 'alert';
          break;
        case 'CRITICAL':
          indicator = 'critical';
          break;
        default:
          indicator = 'idle';
          break;
      }
      const scopedKey = composeNodeKey(alert.nodeId, alert.siteId);
      applyIndicator(map, scopedKey, indicator);
      // Record a site-agnostic fallback so alerts without a site still pulse nodes.
      const globalKey = composeNodeKey(alert.nodeId, undefined);
      applyIndicator(map, globalKey, indicator);
    });
    return map;
  }, [alerts]);

  const [drawingGeofence, setDrawingGeofence] = useState(false);
  const [draftVertices, setDraftVertices] = useState<GeofenceVertex[]>([]);
  const [hoverVertex, setHoverVertex] = useState<GeofenceVertex | null>(null);

  const performFit = useCallback(() => {
    if (!mapReady || !mapRef.current) {
      return false;
    }
    const positions = nodeList
      .map((node) =>
        typeof node.lat === 'number' && typeof node.lon === 'number'
          ? ([node.lat, node.lon] as [number, number])
          : null,
      )
      .filter((value): value is [number, number] => value !== null);
    if (positions.length === 0) {
      return false;
    }
    const bounds = latLngBounds(positions);
    mapRef.current.fitBounds(bounds.pad(0.25));
    return true;
  }, [mapReady, nodeList]);

  const handleFitClick = () => {
    if (fitEnabled) {
      setFitEnabled(false);
      return;
    }
    const fitted = performFit();
    if (fitted) {
      setFitEnabled(true);
    }
  };

  const handleSaveView = () => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    const center = mapRef.current.getCenter();
    const zoom = mapRef.current.getZoom();
    const trimmed = newViewName.trim();
    addView({
      name: trimmed.length > 0 ? trimmed : undefined,
      lat: center.lat,
      lon: center.lng,
      zoom,
    });
    setNewViewName('');
  };

  const handleApplyView = useCallback((view: SavedMapView) => {
    if (!mapRef.current) {
      return;
    }
    mapRef.current.flyTo([view.lat, view.lon], view.zoom, { duration: 1.1 });
  }, []);

  useEffect(() => {
    if (!fitEnabled || !mapReady) {
      return;
    }
    performFit();
  }, [fitEnabled, performFit, nodeList.length, mapReady]);

  useEffect(() => {
    if (!pendingTarget || !mapReady || !mapRef.current) {
      return;
    }
    if (pendingTarget.bounds) {
      const bounds = latLngBounds([pendingTarget.bounds.southWest, pendingTarget.bounds.northEast]);
      mapRef.current.fitBounds(bounds.pad(0.2), { animate: true });
    } else {
      const zoom = pendingTarget.zoom ?? Math.max(mapRef.current.getZoom(), 15);
      mapRef.current.flyTo([pendingTarget.lat, pendingTarget.lon], zoom, {
        duration: 1.2,
      });
    }
    if (pendingTarget.geofenceId) {
      setGeofenceHighlighted(pendingTarget.geofenceId, GEOFENCE_HIGHLIGHT_MS);
    }
    consumeTarget();
  }, [pendingTarget, consumeTarget, setGeofenceHighlighted, mapReady]);

  const geofenceHighlightCount = useMemo(
    () => Object.keys(geofenceHighlights).length,
    [geofenceHighlights],
  );

  useEffect(() => {
    if (geofenceHighlightCount === 0) {
      return;
    }
    const timer = window.setInterval(() => pruneGeofenceHighlights(), 1000);
    return () => window.clearInterval(timer);
  }, [geofenceHighlightCount, pruneGeofenceHighlights]);

  const startGeofenceDrawing = () => {
    setDrawingGeofence(true);
    setDraftVertices([]);
    setHoverVertex(null);
  };

  const cancelGeofenceDrawing = () => {
    setDrawingGeofence(false);
    setDraftVertices([]);
    setHoverVertex(null);
  };

  const undoGeofencePoint = () => {
    setDraftVertices((prev) => prev.slice(0, -1));
  };

  const handleMapPoint = (vertex: GeofenceVertex) => {
    if (!drawingGeofence) {
      return;
    }
    setDraftVertices((prev) => [...prev, vertex]);
  };

  const handleHover = (vertex: GeofenceVertex | null) => {
    if (!drawingGeofence) {
      return;
    }
    setHoverVertex(vertex);
  };

  const handleSaveGeofence = async () => {
    if (draftVertices.length < 3) {
      alert('Draw at least three points to create a geofence.');
      return;
    }
    const defaultName = `Geofence ${geofences.length + 1}`;
    const name = window.prompt('Geofence name', defaultName);
    if (!name) {
      return;
    }
    const message =
      window.prompt(
        'Custom alarm message (tokens: {entity}, {geofence}, {type}, {event})',
        '{entity} entered geofence {geofence}',
      ) ?? '{entity} entered geofence {geofence}';
    const alarmLevel = window.prompt('Alarm level (INFO, NOTICE, ALERT, CRITICAL)', 'ALERT');
    const level = normalizeAlarmLevel(alarmLevel);

    try {
      const geofence = await addGeofence({
        name,
        description: null,
        siteId: selectedSiteId || undefined,
        polygon: draftVertices,
        alarm: {
          enabled: true,
          level,
          message,
          triggerOnExit: false,
        },
      });

      const center = calculatePolygonCentroid(draftVertices);
      goto({
        lat: center.lat,
        lon: center.lon,
        zoom: Math.max(mapRef.current?.getZoom() ?? 13, 15),
      });

      cancelGeofenceDrawing();
      setGeofenceHighlighted(geofence.id, GEOFENCE_HIGHLIGHT_MS);

      window.setTimeout(() => {
        alert(`Geofence "${geofence.name}" created.`);
      }, 10);
    } catch (error) {
      console.error('Failed to create geofence', error);
      alert('Failed to create geofence. Please try again.');
    }
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Operational Map</h1>
          <p className="panel__subtitle">
            {onlineCount} nodes online | {nodeList.length} total tracked
          </p>
        </div>
        <div className="controls-row">
          <button
            type="button"
            className={`control-chip ${fitEnabled ? 'is-active' : ''}`}
            onClick={handleFitClick}
          >
            <MdCenterFocusStrong /> Fit
          </button>
          <button
            type="button"
            className={`control-chip ${trailsEnabled ? 'is-active' : ''}`}
            onClick={toggleTrails}
          >
            <MdTimeline /> Trails
          </button>
          <button
            type="button"
            className={`control-chip ${followEnabled ? 'is-active' : ''}`}
            onClick={toggleFollow}
          >
            <MdMyLocation /> Follow
          </button>
          <button
            type="button"
            className={`control-chip ${radiusEnabled ? 'is-active' : ''}`}
            onClick={toggleRadius}
          >
            <MdRadioButtonChecked /> Radius
          </button>
          <button
            type="button"
            className={`control-chip ${targetsEnabled ? 'is-active' : ''}`}
            onClick={toggleTargets}
          >
            <MdVisibility /> Targets
          </button>
        </div>
      </header>
      <div className="map-canvas">
        <CommandCenterMap
          nodes={nodeList}
          trails={histories}
          targets={targetMarkers}
          alertIndicators={alertIndicatorMap}
          alertColors={alertColors}
          defaultRadius={mapDefaultRadius}
          showRadius={radiusEnabled}
          showTrails={trailsEnabled}
          showTargets={targetsEnabled}
          followEnabled={followEnabled}
          showCoverage={coverageEnabled}
          mapStyle={mapStyle}
          onMapStyleChange={setMapStyle}
          geofences={geofences}
          geofenceHighlights={geofenceHighlights}
          drawing={
            drawingGeofence
              ? {
                  enabled: true,
                  points: draftVertices,
                  hover: hoverVertex,
                  onPoint: handleMapPoint,
                  onHover: handleHover,
                }
              : undefined
          }
          onReady={(map) => {
            mapRef.current = map;
            setMapReady(true);
          }}
        />
      </div>
      <footer className="map-footer">
        <section className="map-footer__views">
          <div className="map-footer__views-controls">
            <input
              type="text"
              placeholder="View name"
              value={newViewName}
              className="control-input"
              onChange={(event) => setNewViewName(event.target.value)}
            />
            <button
              type="button"
              className="control-chip"
              onClick={handleSaveView}
              disabled={!mapReady || !mapRef.current}
            >
              <MdBookmarkAdd /> Save View
            </button>
          </div>
          {savedViews.length > 0 ? (
            <div className="map-footer__views-list">
              {savedViews.map((view) => (
                <div key={view.id} className="map-footer__view-item">
                  <button
                    type="button"
                    className="control-chip"
                    onClick={() => handleApplyView(view)}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    className="control-chip control-chip--danger"
                    onClick={() => removeView(view.id)}
                    aria-label={`Remove ${view.name}`}
                  >
                    <MdClose />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Save map views for quick navigation.</p>
          )}
        </section>
        <div className="map-footer__actions">
          <label className="geofence-site-select">
            <span className="geofence-site-select__label">Site</span>
            <select
              className="control-input"
              value={selectedSiteId}
              onChange={(event) => setSelectedSiteId(event.target.value)}
              aria-label="Site"
            >
              <option value="">Local site</option>
              {sitesQuery.data?.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name ?? site.id}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="submit-button"
            onClick={startGeofenceDrawing}
            disabled={drawingGeofence}
          >
            <MdCropFree /> Create Geofence
          </button>
          {drawingGeofence ? (
            <div className="geofence-drawing-controls">
              <span>{draftVertices.length} point(s) selected. Click map to add more.</span>
              <div className="geofence-drawing-buttons">
                <button
                  type="button"
                  onClick={undoGeofencePoint}
                  disabled={draftVertices.length === 0}
                >
                  <MdUndo /> Undo
                </button>
                <button type="button" onClick={cancelGeofenceDrawing}>
                  <MdCancel /> Cancel
                </button>
                <button
                  type="button"
                  className="submit-button"
                  onClick={handleSaveGeofence}
                  disabled={draftVertices.length < 3}
                >
                  <MdCheckCircle /> Save Geofence
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </footer>
    </section>
  );
}

function composeNodeKey(nodeId: string, siteId?: string | null): string {
  return `${siteId ?? 'default'}::${canonicalNodeId(nodeId)}`;
}

function normalizeAlarmLevel(value: string | null): AlarmLevel {
  const normalized = (value ?? '').toUpperCase();
  if (
    normalized === 'CRITICAL' ||
    normalized === 'ALERT' ||
    normalized === 'NOTICE' ||
    normalized === 'INFO'
  ) {
    return normalized;
  }
  return 'ALERT';
}

function calculatePolygonCentroid(points: GeofenceVertex[]): GeofenceVertex {
  if (points.length === 0) {
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
