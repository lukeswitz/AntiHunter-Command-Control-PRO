import { useQuery } from '@tanstack/react-query';
import L, { latLngBounds, type LatLngExpression } from 'leaflet';
import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  MdBookmarkAdd,
  MdCancel,
  MdCheckCircle,
  MdClose,
  MdCropFree,
  MdUndo,
} from 'react-icons/md';
import {
  Circle,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';

import { apiClient } from '../api/client';
import type { AlarmLevel, Geofence, GeofenceVertex, SiteSummary } from '../api/types';
import { useGeofenceStore } from '../stores/geofence-store';
import { type SavedMapView, useMapViewsStore } from '../stores/map-views-store';

const DEFAULT_RADIUS = 100;
const DEFAULT_OVERLAP = 0;
const EARTH_RADIUS = 6_371_000;
const CUSTOM_PRESET_ID = 'custom';
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors';
const SLIDE_RANGE_METERS = 200;
const LATERAL_RANGE_METERS = 120;
const METERS_PER_DEGREE_LAT = 111_320;

type NodeDeploymentType = 'wifi' | 'radar' | 'rf';

interface NodeProfile {
  id: string;
  label: string;
  type: NodeDeploymentType;
  defaultRadius: number;
  defaultOverlap: number;
  arcWidth: number;
  notes: string;
  color: string;
}

const NODE_PROFILES: NodeProfile[] = [
  {
    id: 'wifi-standard',
    label: 'WiFi / BLE perimeter',
    type: 'wifi',
    defaultRadius: 50,
    defaultOverlap: 50,
    arcWidth: 360,
    notes: 'Balanced omni coverage hugging the fence line.',
    color: '#2563eb',
  },
  {
    id: 'wifi-long-range',
    label: 'WiFi long-range',
    type: 'wifi',
    defaultRadius: 320,
    defaultOverlap: 60,
    arcWidth: 360,
    notes: 'Long-range omni nodes for sparse or rapid deployments.',
    color: '#1d4ed8',
  },
  {
    id: 'radar-sector',
    label: 'RADAR 90-degree sector',
    type: 'radar',
    defaultRadius: 180,
    defaultOverlap: 15,
    arcWidth: 90,
    notes: 'Directional sector coverage for choke points.',
    color: '#f97316',
  },
  {
    id: 'radar-wide',
    label: 'RADAR 120-degree sector',
    type: 'radar',
    defaultRadius: 210,
    defaultOverlap: 25,
    arcWidth: 120,
    notes: 'Wider sector coverage for broad approaches.',
    color: '#fb923c',
  },
  {
    id: 'radar-needle',
    label: 'RADAR 20-degree micro sector',
    type: 'radar',
    defaultRadius: 100,
    defaultOverlap: 5,
    arcWidth: 20,
    notes: 'Tightly focused beam for long-distance cueing or needle sweeps.',
    color: '#fcd34d',
  },
  {
    id: 'rf-longhaul',
    label: 'RF relay (360-degree)',
    type: 'rf',
    defaultRadius: 400,
    defaultOverlap: 80,
    arcWidth: 360,
    notes: 'High-power RF relay for extended perimeter segments.',
    color: '#10b981',
  },
] as const;

type NodeProfileId = (typeof NODE_PROFILES)[number]['id'];

const PROFILE_BY_ID = new Map<string, NodeProfile>(
  NODE_PROFILES.map((profile) => [profile.id, profile]),
);

interface StrategyNode {
  id: string;
  displayName?: string;
  lat: number;
  lon: number;
  radius: number;
  spacing: number;
  overlap: number;
  type: NodeDeploymentType;
  profileId: NodeProfileId;
  arcWidth: number;
  orientation?: number;
  anchorDistance?: number;
  flags: string[];
  tangentBearing: number;
  normalBearing: number;
  path?: NodePathData;
}

interface StrategyResult {
  nodes: StrategyNode[];
  perimeter: number;
  spacing: number;
}

interface StrategyPreset {
  id: string;
  label: string;
  description: string;
  profileId: NodeProfileId;
  radius: number;
  overlap: number;
  offset: number;
  maxAnchorDistance?: number;
}

const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'perimeter-balanced',
    label: 'Perimeter patrol (balanced)',
    description: 'Omni WiFi nodes hugging the fence line with mild overlap.',
    profileId: 'wifi-standard',
    radius: 50,
    overlap: 50,
    offset: -5,
    maxAnchorDistance: 60,
  },
  {
    id: 'rapid-deploy',
    label: 'Rapid deploy (sparse)',
    description: 'Long-range WiFi nodes with minimal count for quick cordon.',
    profileId: 'wifi-long-range',
    radius: 320,
    overlap: 30,
    offset: -15,
    maxAnchorDistance: 80,
  },
  {
    id: 'radar-choke',
    label: 'RADAR choke coverage',
    description: 'Directional radar nodes offset outward for approach monitoring.',
    profileId: 'radar-sector',
    radius: 180,
    overlap: 10,
    offset: 20,
    maxAnchorDistance: 40,
  },
  {
    id: 'relay-ring',
    label: 'RF relay perimeter',
    description: 'High-power RF relays with heavier overlap for dense coverage.',
    profileId: 'rf-longhaul',
    radius: 380,
    overlap: 90,
    offset: 0,
    maxAnchorDistance: 120,
  },
] as const;

const STRATEGY_PANELS = [
  { id: 'plan', label: 'Plan', description: 'Presets & coverage tuning' },
  { id: 'areas', label: 'Areas & Anchors', description: 'Geofences, anchors, obstacles' },
  { id: 'summary', label: 'Summary', description: 'Totals & quick exports' },
] as const;

type StrategyPanelId = (typeof STRATEGY_PANELS)[number]['id'];

interface AnchorPoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

type AvoidancePolygon = GeofenceVertex[];

interface StrategyOptions {
  profile: NodeProfile;
  radius: number;
  overlap: number;
  offset: number;
  avoidancePolygons: AvoidancePolygon[];
  anchors: AnchorPoint[];
  maxAnchorDistance?: number;
}

interface NodeOverride {
  radius?: number;
  orientation?: number;
  arcWidth?: number;
  slideMeters?: number;
  moveNorthMeters?: number;
  moveEastMeters?: number;
  name?: string;
  profileId?: NodeProfileId;
}

interface NodePathData {
  origin: GeofenceVertex;
  projected: { x: number; y: number }[];
  perimeter: number;
  isCounterClockwise: boolean;
  distanceAlong: number;
  normalShift: number;
}

export function StrategyAdvisorPage() {
  const geofences = useGeofenceStore((state) => state.geofences);
  const loadGeofences = useGeofenceStore((state) => state.loadGeofences);
  const addGeofence = useGeofenceStore((state) => state.addGeofence);

  const [selectedGeofenceIds, setSelectedGeofenceIds] = useState<string[]>([]);
  const [activePanel, setActivePanel] = useState<StrategyPanelId>('plan');
  const [activePresetId, setActivePresetId] = useState<string>(STRATEGY_PRESETS[0].id);
  const [profileId, setProfileId] = useState<NodeProfileId>(STRATEGY_PRESETS[0].profileId);
  const [radius, setRadius] = useState<number>(STRATEGY_PRESETS[0].radius ?? DEFAULT_RADIUS);
  const [overlap, setOverlap] = useState<number>(STRATEGY_PRESETS[0].overlap ?? DEFAULT_OVERLAP);
  const [offset, setOffset] = useState<number>(STRATEGY_PRESETS[0].offset ?? 0);
  const [maxAnchorDistance, setMaxAnchorDistance] = useState<number | undefined>(
    STRATEGY_PRESETS[0].maxAnchorDistance,
  );
  const [anchors, setAnchors] = useState<AnchorPoint[]>([]);
  const [anchorDraft, setAnchorDraft] = useState<{ name: string; lat: string; lon: string }>({
    name: '',
    lat: '',
    lon: '',
  });
  const [avoidancePolygons, setAvoidancePolygons] = useState<AvoidancePolygon[]>([]);
  const [obstacleError, setObstacleError] = useState<string | null>(null);
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, NodeOverride>>({});
  const [removedNodeIds, setRemovedNodeIds] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string>('');
  const [drawingGeofence, setDrawingGeofence] = useState(false);
  const [draftVertices, setDraftVertices] = useState<GeofenceVertex[]>([]);
  const [hoverVertex, setHoverVertex] = useState<GeofenceVertex | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const savedViews = useMapViewsStore((state) => state.views);
  const addView = useMapViewsStore((state) => state.addView);
  const removeView = useMapViewsStore((state) => state.removeView);
  const [fitEnabled, setFitEnabled] = useState(true);
  const [inspectorVisible, setInspectorVisible] = useState(true);
  const idBase = useId();
  const presetSelectId = `${idBase}-preset`;
  const profileSelectId = `${idBase}-profile`;
  const radiusInputId = `${idBase}-radius`;
  const overlapInputId = `${idBase}-overlap`;
  const offsetInputId = `${idBase}-offset`;
  const maxAnchorInputId = `${idBase}-anchor`;
  const geofenceCheckboxGroupId = `${idBase}-geofences`;
  const obstacleInputId = `${idBase}-obstacle`;
  const anchorNameId = `${idBase}-anchor-name`;
  const anchorLatId = `${idBase}-anchor-lat`;
  const anchorLonId = `${idBase}-anchor-lon`;
  const inspectorTitleId = `${idBase}-inspector-title`;
  const inspectorNameInputId = `${idBase}-inspector-name`;
  const inspectorProfileSelectId = `${idBase}-inspector-profile`;
  const inspectorRadiusInputId = `${idBase}-inspector-radius`;
  const inspectorOrientationInputId = `${idBase}-inspector-orientation`;
  const inspectorArcInputId = `${idBase}-inspector-arc`;
  const inspectorSlideInputId = `${idBase}-inspector-slide`;
  const inspectorNorthInputId = `${idBase}-inspector-north`;
  const inspectorEastInputId = `${idBase}-inspector-east`;
  const panelTitleId = `${idBase}-panel-title`;

  useEffect(() => {
    void loadGeofences();
  }, [loadGeofences]);

  useEffect(() => {
    if (geofences.length === 0) {
      setSelectedGeofenceIds([]);
      return;
    }
    setSelectedGeofenceIds((previous) => {
      const valid = previous.filter((id) => geofences.some((geofence) => geofence.id === id));
      if (valid.length > 0) {
        return valid;
      }
      return [geofences[0].id];
    });
  }, [geofences]);

  useEffect(() => {
    if (activePresetId === CUSTOM_PRESET_ID) {
      return;
    }
    const preset = STRATEGY_PRESETS.find((item) => item.id === activePresetId);
    if (!preset) {
      return;
    }
    setProfileId(preset.profileId);
    setRadius(preset.radius);
    setOverlap(preset.overlap);
    setOffset(preset.offset);
    setMaxAnchorDistance(preset.maxAnchorDistance);
  }, [activePresetId]);

  const activeProfile = PROFILE_BY_ID.get(profileId) ?? NODE_PROFILES[0];

  const selectedGeofences = useMemo<Geofence[]>(
    () => geofences.filter((geofence) => selectedGeofenceIds.includes(geofence.id)),
    [geofences, selectedGeofenceIds],
  );

  const baseStrategy = useMemo<StrategyResult>(() => {
    const polygons = selectedGeofences
      .map((geofence) => geofence.polygon ?? [])
      .filter((polygon) => polygon.length >= 3);
    if (polygons.length === 0) {
      return { nodes: [], perimeter: 0, spacing: 0 };
    }
    return buildStrategy(polygons, {
      profile: activeProfile,
      radius: Math.max(1, radius),
      overlap: Math.max(0, overlap),
      offset,
      avoidancePolygons,
      anchors,
      maxAnchorDistance,
    });
  }, [
    selectedGeofences,
    activeProfile,
    radius,
    overlap,
    offset,
    avoidancePolygons,
    anchors,
    maxAnchorDistance,
  ]);

  const baseNodeLookup = useMemo(
    () => new Map(baseStrategy.nodes.map((node) => [node.id, node])),
    [baseStrategy],
  );

  useEffect(() => {
    setNodeOverrides((previous) => {
      const validIds = new Set(baseStrategy.nodes.map((node) => node.id));
      let mutated = false;
      const next = { ...previous };
      Object.keys(previous).forEach((id) => {
        if (!validIds.has(id)) {
          delete next[id];
          mutated = true;
        }
      });
      return mutated ? next : previous;
    });
  }, [baseStrategy]);

  const strategy = useMemo<StrategyResult>(() => {
    if (baseStrategy.nodes.length === 0) {
      return baseStrategy;
    }
    const relevantNodes =
      removedNodeIds.size === 0
        ? baseStrategy.nodes
        : baseStrategy.nodes.filter((node) => !removedNodeIds.has(node.id));
    const nodes = relevantNodes.map((node) => {
      const override = nodeOverrides[node.id];
      if (!override) {
        return { ...node, displayName: node.displayName ?? node.id };
      }

      let lat = node.lat;
      let lon = node.lon;
      let radius = node.radius;
      let arcWidth = node.arcWidth;
      let orientation = node.orientation;
      let profileId = node.profileId;
      let type = node.type;
      let tangentBearing = node.tangentBearing;
      let normalBearing = node.normalBearing;
      const displayName =
        override.name && override.name.trim().length > 0
          ? override.name.trim()
          : (node.displayName ?? node.id);

      if (override.profileId && PROFILE_BY_ID.has(override.profileId)) {
        const profileOverride = PROFILE_BY_ID.get(override.profileId)!;
        profileId = profileOverride.id;
        type = profileOverride.type;
        if (override.arcWidth == null) {
          arcWidth = profileOverride.arcWidth;
        }
        if (profileOverride.arcWidth < 360) {
          if (override.orientation == null) {
            orientation = node.normalBearing;
          }
        } else if (override.orientation == null) {
          orientation = undefined;
        }
      }

      if (override.arcWidth != null) {
        arcWidth = Math.min(360, Math.max(10, override.arcWidth));
      }
      if (override.radius != null) {
        radius = Math.max(1, override.radius);
      }
      if (override.orientation != null) {
        orientation = ((override.orientation % 360) + 360) % 360;
      }

      const path = node.path;
      if (path) {
        const slideMeters = override.slideMeters ?? 0;
        const normalizedDistance =
          (((path.distanceAlong + slideMeters) % path.perimeter) + path.perimeter) % path.perimeter;
        const sample = samplePointAlong(path.projected, normalizedDistance);
        const normalVec = computeNormal(sample.segmentDirection, path.isCounterClockwise);
        const tangentVec = sample.segmentDirection;
        const offsetPoint = {
          x: sample.point.x + normalVec.x * path.normalShift,
          y: sample.point.y + normalVec.y * path.normalShift,
        };
        const latLon = unproject(offsetPoint, path.origin);
        lat = latLon.lat;
        lon = latLon.lon;
        tangentBearing = toBearingDegrees(tangentVec);
        normalBearing = toBearingDegrees(normalVec);
        if (override.orientation == null && arcWidth < 360) {
          orientation = normalBearing;
        }
      }

      const applyOffset = (meters: number | undefined, bearing: number) => {
        if (meters == null || Number.isNaN(meters) || meters === 0) {
          return;
        }
        const direction = meters >= 0 ? bearing : (bearing + 180) % 360;
        [lat, lon] = projectInDirection(lat, lon, Math.abs(meters), direction);
      };

      applyOffset(override.moveNorthMeters, 0);
      applyOffset(override.moveEastMeters, 90);

      return {
        ...node,
        lat,
        lon,
        radius,
        arcWidth,
        orientation,
        profileId,
        type,
        displayName,
        tangentBearing,
        normalBearing,
      };
    });
    return { ...baseStrategy, nodes };
  }, [baseStrategy, nodeOverrides, removedNodeIds]);

  useEffect(() => {
    if (!selectedNodeId) {
      return;
    }
    if (!strategy.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [strategy.nodes, selectedNodeId]);

  const selectedNode = useMemo(
    () => strategy.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [strategy.nodes, selectedNodeId],
  );
  const selectedNodeOverride = selectedNode ? (nodeOverrides[selectedNode.id] ?? null) : null;
  const baseSelectedNode = selectedNode ? (baseNodeLookup.get(selectedNode.id) ?? null) : null;
  const inspectorHasOverride =
    selectedNodeOverride != null && Object.keys(selectedNodeOverride).length > 0;
  const inspectorRadiusValue = selectedNode?.radius ?? 0;
  const inspectorOrientationValue = selectedNode?.orientation ?? baseSelectedNode?.orientation ?? 0;
  const inspectorArcValue = selectedNode?.arcWidth ?? baseSelectedNode?.arcWidth ?? 360;
  const inspectorSupportsDirection = selectedNode ? selectedNode.arcWidth < 360 : false;
  const inspectorNameValue = selectedNode
    ? (selectedNodeOverride?.name ?? selectedNode.displayName ?? selectedNode.id)
    : '';
  const inspectorProfileValue = selectedNodeOverride?.profileId ?? '';
  const inspectorSlideValue = selectedNodeOverride?.slideMeters ?? 0;
  const inspectorNorthValue = selectedNodeOverride?.moveNorthMeters ?? 0;
  const inspectorEastValue = selectedNodeOverride?.moveEastMeters ?? 0;
  const renderPlanPanel = () => (
    <>
      <div className="form-section">
        <label className="form-label" htmlFor={presetSelectId}>
          Scenario preset
        </label>
        <select
          id={presetSelectId}
          className="control-input"
          value={activePresetId}
          onChange={handlePresetChange}
        >
          {STRATEGY_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value={CUSTOM_PRESET_ID}>Custom (manual adjustments)</option>
        </select>
        <p className="form-hint">
          Presets apply recommended radius, overlap, and offsets. Any manual change switches to the
          Custom profile.
        </p>
        {activePresetId !== CUSTOM_PRESET_ID ? (
          <p className="form-hint">
            {STRATEGY_PRESETS.find((preset) => preset.id === activePresetId)?.description}
          </p>
        ) : null}
      </div>

      <div className="form-section">
        <label className="form-label" htmlFor={profileSelectId}>
          Node profile
        </label>
        <select
          id={profileSelectId}
          className="control-input"
          value={profileId}
          onChange={handleProfileChange}
        >
          {NODE_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
        <p className="form-hint">{activeProfile.notes}</p>
      </div>

      <div className="form-section form-grid">
        <div className="form-group">
          <label className="form-label" htmlFor={radiusInputId}>
            Coverage radius (m)
          </label>
          <input
            id={radiusInputId}
            className="control-input"
            type="number"
            min={1}
            value={radius}
            onChange={(event) => handleRadiusChange(Number(event.target.value))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={overlapInputId}>
            Overlap (m)
          </label>
          <input
            id={overlapInputId}
            className="control-input"
            type="number"
            min={0}
            value={overlap}
            onChange={(event) => handleOverlapChange(Number(event.target.value))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={offsetInputId}>
            Offset from boundary (m)
          </label>
          <input
            id={offsetInputId}
            className="control-input"
            type="number"
            value={offset}
            onChange={(event) => handleOffsetChange(Number(event.target.value))}
          />
          <p className="form-hint">
            Positive offsets push nodes outward; negative offsets pull nodes inward.
          </p>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor={maxAnchorInputId}>
            Max backhaul distance (m)
          </label>
          <input
            id={maxAnchorInputId}
            className="control-input"
            type="number"
            min={0}
            value={maxAnchorDistance ?? ''}
            placeholder="Optional"
            onChange={(event) => {
              const parsed = event.target.value.trim();
              handleMaxAnchorChange(parsed === '' ? undefined : Number(parsed));
            }}
          />
          <p className="form-hint">
            Leave blank to ignore distance checks. Nodes beyond this distance are flagged.
          </p>
        </div>
      </div>
    </>
  );

  const renderAreasPanel = () => (
    <>
      <div className="form-section">
        <span className="form-label" id={geofenceCheckboxGroupId}>
          Geofences to include
        </span>
        <div className="geofence-checkboxes" role="group" aria-labelledby={geofenceCheckboxGroupId}>
          {geofences.length === 0 ? (
            <p className="form-hint">
              No geofences available. Use the Create Geofence control above to draw one.
            </p>
          ) : (
            geofences.map((geofence) => (
              <label key={geofence.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectedGeofenceIds.includes(geofence.id)}
                  onChange={(event) => handleGeofenceToggle(geofence.id, event.target.checked)}
                />
                <span>
                  {geofence.name}{' '}
                  <span className="muted">
                    ({geofence.polygon ? `${geofence.polygon.length} vertices` : 'no polygon'})
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
      </div>

      <div className="form-section">
        <div className="form-label">Backhaul anchors</div>
        <p className="form-hint">
          Anchors represent power or network drops. Nodes exceeding the max distance from the
          nearest anchor are flagged for review.
        </p>
        <form className="anchor-form" onSubmit={handleAnchorAdd}>
          <div className="anchor-grid">
            <label className="form-label" htmlFor={anchorNameId}>
              Name
            </label>
            <input
              id={anchorNameId}
              name="name"
              className="control-input"
              value={anchorDraft.name}
              onChange={handleAnchorDraftChange}
              placeholder="Ops Room"
            />
            <label className="form-label" htmlFor={anchorLatId}>
              Latitude
            </label>
            <input
              id={anchorLatId}
              name="lat"
              className="control-input"
              value={anchorDraft.lat}
              onChange={handleAnchorDraftChange}
              placeholder="e.g. 40.7128"
            />
            <label className="form-label" htmlFor={anchorLonId}>
              Longitude
            </label>
            <input
              id={anchorLonId}
              name="lon"
              className="control-input"
              value={anchorDraft.lon}
              onChange={handleAnchorDraftChange}
              placeholder="e.g. -74.0060"
            />
          </div>
          <div className="anchor-actions">
            <button type="submit" className="control-chip">
              Add anchor
            </button>
          </div>
        </form>
        {anchors.length > 0 ? (
          <ul className="strategy-anchor-list">
            {anchors.map((anchor) => (
              <li key={anchor.id}>
                <span>
                  {anchor.name} - {anchor.lat.toFixed(5)}, {anchor.lon.toFixed(5)}
                </span>
                <button
                  type="button"
                  className="control-chip control-chip--danger"
                  onClick={() => handleAnchorRemove(anchor.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="form-section">
        <label className="form-label" htmlFor={obstacleInputId}>
          Obstruction GeoJSON (optional)
        </label>
        <input
          id={obstacleInputId}
          type="file"
          accept="application/geo+json,application/json"
          onChange={handleObstacleUpload}
        />
        {obstacleError ? (
          <p className="form-error">{obstacleError}</p>
        ) : (
          <p className="form-hint">
            Upload polygons representing no-go areas (buildings, water, etc.). Nodes close to or
            within these areas are adjusted automatically.
          </p>
        )}
        {avoidancePolygons.length > 0 ? (
          <div className="strategy-obstacles__actions">
            <span className="muted">{avoidancePolygons.length} exclusion zone(s) active.</span>
            <button type="button" className="control-chip" onClick={handleObstacleClear}>
              Clear exclusions
            </button>
          </div>
        ) : null}
      </div>
    </>
  );

  const renderSummaryPanel = () => (
    <div className="strategy-summary">
      <dl>
        <div>
          <dt>Perimeter</dt>
          <dd>{strategy.perimeter.toFixed(1)} m</dd>
        </div>
        <div>
          <dt>Nodes</dt>
          <dd>{strategy.nodes.length}</dd>
        </div>
        <div>
          <dt>Avg spacing</dt>
          <dd>{strategy.spacing.toFixed(1)} m</dd>
        </div>
      </dl>
      <p className="form-hint">
        Use the export controls above to share the plan or load it into other tooling.
      </p>
    </div>
  );
  const renderActivePanelContent = () => {
    if (activePanel === 'areas') {
      return renderAreasPanel();
    }
    if (activePanel === 'summary') {
      return renderSummaryPanel();
    }
    return renderPlanPanel();
  };
  const mapBounds = useMemo(() => {
    const points: Array<[number, number]> = [];
    selectedGeofences.forEach((geofence) => {
      geofence.polygon?.forEach((vertex) => points.push([vertex.lat, vertex.lon]));
    });
    avoidancePolygons.forEach((polygon) => {
      polygon.forEach((vertex) => points.push([vertex.lat, vertex.lon]));
    });
    strategy.nodes.forEach((node) => points.push([node.lat, node.lon]));
    if (points.length === 0) {
      return latLngBounds([[0, 0]]);
    }
    return latLngBounds(points);
  }, [selectedGeofences, avoidancePolygons, strategy.nodes]);

  const performFit = useCallback(() => {
    if (!mapRef.current) {
      return false;
    }
    if (!mapBounds.isValid()) {
      return false;
    }
    mapRef.current.fitBounds(mapBounds, { padding: [32, 32] });
    return true;
  }, [mapBounds]);

  const drawingPositions = useMemo<LatLngExpression[]>(() => {
    if (!drawingGeofence || draftVertices.length === 0) {
      return [];
    }
    const base = draftVertices.map((vertex) => [vertex.lat, vertex.lon] as LatLngExpression);
    if (hoverVertex) {
      base.push([hoverVertex.lat, hoverVertex.lon]);
    }
    return base;
  }, [drawingGeofence, draftVertices, hoverVertex]);

  useEffect(() => {
    if (!fitEnabled || !mapReady) {
      return;
    }
    performFit();
  }, [fitEnabled, mapReady, performFit]);

  const { data: sitesQueryData } = useQuery({
    queryKey: ['sites', 'strategy-advisor'],
    queryFn: async () => apiClient.get<SiteSummary[]>('/sites'),
    staleTime: 300_000,
  });

  const planWarnings = useMemo(() => {
    const warnings = new Set<string>();
    if (selectedGeofences.length === 0) {
      warnings.add('Select at least one geofence to generate a deployment plan.');
    }
    if (strategy.nodes.some((node) => node.flags.includes('obstruction-overlap'))) {
      warnings.add(
        'One or more nodes overlap with an obstruction. Adjust offsets or upload a refined exclusion zone.',
      );
    }
    if (strategy.nodes.some((node) => node.flags.includes('anchor-constraint'))) {
      warnings.add('Some nodes exceed the maximum backhaul distance from the nearest anchor.');
    }
    return Array.from(warnings);
  }, [selectedGeofences.length, strategy.nodes]);

  const hasNodes = strategy.nodes.length > 0;
  const activePanelDefinition =
    STRATEGY_PANELS.find((panel) => panel.id === activePanel) ?? STRATEGY_PANELS[0];
  const handleBookmarkNode = (node: StrategyNode | null) => {
    if (!node) {
      return;
    }
    const snippet = `${node.displayName ?? node.id} · ${node.profileId} · ${node.lat.toFixed(
      5,
    )}, ${node.lon.toFixed(5)}`;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(snippet).catch(() => {
        window.prompt('Copy node details', snippet);
      });
    } else {
      window.prompt('Copy node details', snippet);
    }
  };
  const handleInspectorReset = () => {
    if (!selectedNode) {
      return;
    }
    resetNodeOverride(selectedNode.id);
  };
  const handleDeleteNode = (nodeId: string) => {
    setRemovedNodeIds((previous) => {
      if (previous.has(nodeId)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(nodeId);
      return next;
    });
    setNodeOverrides((previous) => {
      if (!(nodeId in previous)) {
        return previous;
      }
      const next = { ...previous };
      delete next[nodeId];
      return next;
    });
    setSelectedNodeId((current) => (current === nodeId ? null : current));
  };
  const handlePresetChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setActivePresetId(event.target.value);
  };

  const handleProfileChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextProfile = event.target.value as NodeProfileId;
    setProfileId(nextProfile);
    const defaults = PROFILE_BY_ID.get(nextProfile);
    if (defaults) {
      setRadius(defaults.defaultRadius);
      setOverlap(defaults.defaultOverlap);
    }
    setActivePresetId(CUSTOM_PRESET_ID);
  };

  const handleGeofenceToggle = (geofenceId: string, checked: boolean) => {
    setSelectedGeofenceIds((previous) => {
      if (checked) {
        if (previous.includes(geofenceId)) {
          return previous;
        }
        return [...previous, geofenceId];
      }
      if (previous.length === 1 && previous[0] === geofenceId) {
        return previous;
      }
      return previous.filter((value) => value !== geofenceId);
    });
  };

  const handleAnchorDraftChange = (event: ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.target;
    setAnchorDraft((draft) => ({ ...draft, [name]: value }));
  };

  const handleAnchorAdd = (event: FormEvent) => {
    event.preventDefault();
    const { name, lat, lon } = anchorDraft;
    const parsedLat = Number(lat);
    const parsedLon = Number(lon);
    if (!name.trim() || Number.isNaN(parsedLat) || Number.isNaN(parsedLon)) {
      return;
    }
    setAnchors((current) => [
      ...current,
      { id: `${Date.now()}`, name: name.trim(), lat: parsedLat, lon: parsedLon },
    ]);
    setAnchorDraft({ name: '', lat: '', lon: '' });
  };

  const handleAnchorRemove = (anchorId: string) => {
    setAnchors((current) => current.filter((anchor) => anchor.id !== anchorId));
  };

  const handleObstacleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const polygons = extractPolygonsFromGeoJson(parsed);
        if (polygons.length === 0) {
          setObstacleError('No Polygon or MultiPolygon data found in GeoJSON.');
          return;
        }
        setAvoidancePolygons(polygons);
        setObstacleError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to parse GeoJSON file.';
        setObstacleError(message);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleObstacleClear = () => {
    setAvoidancePolygons([]);
    setObstacleError(null);
  };

  const updateNodeOverride = (nodeId: string, changes: NodeOverride) => {
    const baseNode = baseNodeLookup.get(nodeId);
    if (!baseNode) {
      return;
    }
    setNodeOverrides((previous) => {
      const current = previous[nodeId] ?? {};
      const next: NodeOverride = { ...current };

      const normalizeMeters = (value?: number) => {
        if (value == null || Number.isNaN(value) || Math.abs(value) < 0.01) {
          return undefined;
        }
        return Math.max(-1_000, Math.min(1_000, value));
      };

      if (changes.radius !== undefined) {
        const normalized = Math.max(1, changes.radius);
        if (Number.isFinite(normalized)) {
          next.radius = normalized;
        }
      }

      if (changes.orientation !== undefined) {
        if (changes.orientation == null || Number.isNaN(changes.orientation)) {
          delete next.orientation;
        } else {
          const normalized = ((changes.orientation % 360) + 360) % 360;
          next.orientation = normalized;
        }
      }

      if (changes.arcWidth !== undefined) {
        if (changes.arcWidth == null || Number.isNaN(changes.arcWidth)) {
          delete next.arcWidth;
        } else {
          const normalized = Math.min(360, Math.max(10, changes.arcWidth));
          next.arcWidth = normalized;
        }
      }

      if (changes.name !== undefined) {
        const baseName = baseNode.displayName ?? baseNode.id;
        const trimmed = (changes.name ?? '').trim();
        if (!trimmed || trimmed === baseName) {
          delete next.name;
        } else {
          next.name = trimmed;
        }
      }

      if (changes.profileId !== undefined) {
        if (!changes.profileId || changes.profileId === baseNode.profileId) {
          delete next.profileId;
        } else if (PROFILE_BY_ID.has(changes.profileId)) {
          next.profileId = changes.profileId;
        }
      }

      if (changes.slideMeters !== undefined) {
        const normalized = normalizeMeters(changes.slideMeters);
        if (normalized === undefined) {
          delete next.slideMeters;
        } else {
          next.slideMeters = normalized;
        }
      }

      if (changes.moveNorthMeters !== undefined) {
        const normalized = normalizeMeters(changes.moveNorthMeters);
        if (normalized === undefined) {
          delete next.moveNorthMeters;
        } else {
          next.moveNorthMeters = normalized;
        }
      }

      if (changes.moveEastMeters !== undefined) {
        const normalized = normalizeMeters(changes.moveEastMeters);
        if (normalized === undefined) {
          delete next.moveEastMeters;
        } else {
          next.moveEastMeters = normalized;
        }
      }

      if (next.radius !== undefined && next.radius === baseNode.radius) {
        delete next.radius;
      }
      if (next.orientation !== undefined && next.orientation === baseNode.orientation) {
        delete next.orientation;
      }
      if (next.arcWidth !== undefined && next.arcWidth === baseNode.arcWidth) {
        delete next.arcWidth;
      }
      if (next.profileId !== undefined && next.profileId === baseNode.profileId) {
        delete next.profileId;
      }
      if (next.name !== undefined && next.name === (baseNode.displayName ?? baseNode.id)) {
        delete next.name;
      }

      if (Object.keys(next).length === 0) {
        if (!previous[nodeId]) {
          return previous;
        }
        const copy = { ...previous };
        delete copy[nodeId];
        return copy;
      }

      return { ...previous, [nodeId]: next };
    });
  };

  const resetNodeOverride = (nodeId: string) => {
    setNodeOverrides((previous) => {
      if (!previous[nodeId]) {
        return previous;
      }
      const copy = { ...previous };
      delete copy[nodeId];
      return copy;
    });
  };

  const handleRadiusChange = (value: number) => {
    setRadius(value);
    setActivePresetId(CUSTOM_PRESET_ID);
  };

  const handleOverlapChange = (value: number) => {
    setOverlap(value);
    setActivePresetId(CUSTOM_PRESET_ID);
  };

  const handleOffsetChange = (value: number) => {
    setOffset(value);
    setActivePresetId(CUSTOM_PRESET_ID);
  };

  const handleMaxAnchorChange = (value: number | undefined) => {
    setMaxAnchorDistance(value);
    setActivePresetId(CUSTOM_PRESET_ID);
  };

  const handleSelectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setInspectorVisible(true);
  };

  const handleShowInspector = useCallback(() => {
    setInspectorVisible(true);
  }, []);

  const handleCloseInspector = () => {
    setSelectedNodeId(null);
    setInspectorVisible(false);
  };

  const handleInspectorRadiusChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId) {
      return;
    }
    const value = Number(event.target.value);
    if (Number.isNaN(value)) {
      return;
    }
    updateNodeOverride(selectedNodeId, { radius: value });
  };

  const handleInspectorOrientationChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId) {
      return;
    }
    const value = Number(event.target.value);
    if (Number.isNaN(value)) {
      return;
    }
    updateNodeOverride(selectedNodeId, { orientation: value });
  };

  const handleInspectorArcChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId) {
      return;
    }
    const value = Number(event.target.value);
    if (Number.isNaN(value)) {
      return;
    }
    updateNodeOverride(selectedNodeId, { arcWidth: value });
  };

  const handleInspectorNameChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId) {
      return;
    }
    updateNodeOverride(selectedNodeId, { name: event.target.value });
  };

  const handleInspectorProfileChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (!selectedNodeId) {
      return;
    }
    const value = event.target.value as NodeProfileId | '';
    updateNodeOverride(selectedNodeId, { profileId: value || undefined });
  };

  const handleInspectorSlideChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId) {
      return;
    }
    const value = Number(event.target.value);
    if (Number.isNaN(value)) {
      return;
    }
    updateNodeOverride(selectedNodeId, { slideMeters: value });
  };

  const handleInspectorNorthChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId) {
      return;
    }
    const value = Number(event.target.value);
    if (Number.isNaN(value)) {
      return;
    }
    updateNodeOverride(selectedNodeId, { moveNorthMeters: value });
  };

  const handleInspectorEastChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (!selectedNodeId) {
      return;
    }
    const value = Number(event.target.value);
    if (Number.isNaN(value)) {
      return;
    }
    updateNodeOverride(selectedNodeId, { moveEastMeters: value });
  };

  const handleStartGeofenceDrawing = () => {
    setDrawingGeofence(true);
    setDraftVertices([]);
    setHoverVertex(null);
  };

  const handleCancelGeofenceDrawing = () => {
    setDrawingGeofence(false);
    setDraftVertices([]);
    setHoverVertex(null);
  };

  const handleUndoGeofencePoint = () => {
    setDraftVertices((prev) => prev.slice(0, -1));
  };

  const handleSaveView = () => {
    if (!mapRef.current) {
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
    setFitEnabled(false);
    mapRef.current.flyTo([view.lat, view.lon], view.zoom, { duration: 1.1 });
  }, []);
  const handleMapReady = useCallback((map: L.Map) => {
    mapRef.current = map;
    setMapReady(true);
  }, []);
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

  const handleMarkerDragEnd = useCallback(
    (node: StrategyNode, lat: number, lon: number) => {
      const { north, east } = computeDeltaMeters(node.lat, node.lon, lat, lon);
      if (Math.abs(north) < 0.01 && Math.abs(east) < 0.01) {
        return;
      }
      const existingNorth = nodeOverrides[node.id]?.moveNorthMeters ?? 0;
      const existingEast = nodeOverrides[node.id]?.moveEastMeters ?? 0;
      updateNodeOverride(node.id, {
        moveNorthMeters: existingNorth + north,
        moveEastMeters: existingEast + east,
      });
      setActivePresetId(CUSTOM_PRESET_ID);
    },
    [nodeOverrides, setActivePresetId, updateNodeOverride],
  );

  const handleGeofencePoint = (vertex: GeofenceVertex) => {
    if (!drawingGeofence) {
      return;
    }
    setDraftVertices((prev) => [...prev, vertex]);
  };

  const handleGeofenceHover = (vertex: GeofenceVertex | null) => {
    if (!drawingGeofence) {
      return;
    }
    setHoverVertex(vertex);
  };

  const handleSaveGeofence = async () => {
    if (draftVertices.length < 3) {
      window.alert('Draw at least three points to create a geofence.');
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
    const levelInput = window.prompt('Alarm level (INFO, NOTICE, ALERT, CRITICAL)', 'ALERT');
    const alarmLevel = normalizeAlarmLevel(levelInput);

    try {
      const geofence = await addGeofence({
        name,
        description: null,
        siteId: selectedSiteId || undefined,
        polygon: draftVertices,
        color: undefined,
        alarm: {
          enabled: true,
          level: alarmLevel,
          message,
        },
      });
      setSelectedGeofenceIds((previous) => Array.from(new Set([...previous, geofence.id])));
      handleCancelGeofenceDrawing();
    } catch (error) {
      console.error('Failed to save geofence', error);
      window.alert('Unable to save geofence. Please try again.');
    }
  };

  const handleExportCsv = () => {
    if (!hasNodes) {
      return;
    }
    const lines = [
      'Name,Latitude,Longitude,Type,Profile,RadiusMeters,OverlapMeters,SpacingMeters,OrientationDegrees,ArcWidthDegrees,AnchorDistanceMeters,Flags',
      ...strategy.nodes.map((node) =>
        [
          node.displayName ?? node.id,
          node.lat.toFixed(6),
          node.lon.toFixed(6),
          node.type.toUpperCase(),
          node.profileId,
          node.radius.toFixed(2),
          node.overlap.toFixed(2),
          node.spacing.toFixed(2),
          node.orientation != null ? node.orientation.toFixed(1) : '',
          node.arcWidth.toFixed(1),
          node.anchorDistance != null ? node.anchorDistance.toFixed(1) : '',
          node.flags.join('|'),
        ].join(','),
      ),
    ];
    downloadText('strategy-nodes.csv', 'text/csv', lines.join('\n'));
  };

  const handleExportGeoJson = () => {
    if (!hasNodes) {
      return;
    }
    const featureCollection = {
      type: 'FeatureCollection',
      features: strategy.nodes.map((node) => ({
        type: 'Feature',
        properties: {
          id: node.id,
          name: node.displayName ?? node.id,
          profileId: node.profileId,
          type: node.type,
          radius: node.radius,
          overlap: node.overlap,
          spacing: node.spacing,
          orientation: node.orientation,
          arcWidth: node.arcWidth,
          anchorDistance: node.anchorDistance,
          flags: node.flags,
        },
        geometry: {
          type: 'Point',
          coordinates: [node.lon, node.lat],
        },
      })),
    };
    downloadText(
      'strategy-nodes.geojson',
      'application/geo+json',
      JSON.stringify(featureCollection, null, 2),
    );
  };

  const handleExportKml = () => {
    if (!hasNodes) {
      return;
    }
    const geofenceKml = selectedGeofences
      .map((geofence) => {
        if (!geofence.polygon || geofence.polygon.length === 0) {
          return '';
        }
        const ring = [...geofence.polygon, geofence.polygon[0]]
          .map((vertex) => `${vertex.lon},${vertex.lat},0`)
          .join(' ');
        return `
    <Placemark>
      <name>${escapeXml(geofence.name ?? 'Geofence')}</name>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${ring}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`;
      })
      .join('\n');

    const nodesKml = strategy.nodes
      .map((node) => {
        const orientationMarkup =
          node.orientation != null ? `<br/>Orientation: ${node.orientation.toFixed(1)}&#176;` : '';
        return `
    <Placemark>
      <name>${escapeXml(node.displayName ?? node.id)}</name>
      <description><![CDATA[
        Profile: ${node.profileId}<br/>
        Type: ${node.type.toUpperCase()}<br/>
        Radius: ${node.radius.toFixed(0)} m<br/>
        Overlap: ${node.overlap.toFixed(0)} m${orientationMarkup}
      ]]></description>
      <Point>
        <coordinates>${node.lon.toFixed(6)},${node.lat.toFixed(6)},0</coordinates>
      </Point>
    </Placemark>`;
      })
      .join('\n');

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Strategy Advisor Export</name>
${geofenceKml}
${nodesKml}
  </Document>
</kml>`;
    downloadText('strategy-plan.kml', 'application/vnd.google-earth.kml+xml', kml);
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Strategy Advisor (Experimental)</h1>
          <p className="panel__subtitle">
            Generate deployment recommendations, account for obstructions, and validate hardware
            availability before heading on site.
          </p>
        </div>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            onClick={handleExportCsv}
            disabled={!hasNodes}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="control-chip"
            onClick={handleExportKml}
            disabled={!hasNodes}
          >
            Export KML
          </button>
          <button
            type="button"
            className="control-chip"
            onClick={handleExportGeoJson}
            disabled={!hasNodes}
          >
            Export GeoJSON
          </button>
        </div>
      </header>
      <div className="strategy-layout">
        <aside className="strategy-menu-column">
          <nav className="strategy-menu" aria-label="Strategy advisor sections">
            {STRATEGY_PANELS.map((panel) => {
              const isActive = panel.id === activePanel;
              const handleClick = () => {
                setActivePanel(panel.id);
                handleShowInspector();
              };
              return (
                <button
                  key={panel.id}
                  type="button"
                  className={`strategy-menu__item${isActive ? ' is-active' : ''}`}
                  aria-pressed={isActive}
                  onClick={handleClick}
                >
                  <span className="strategy-menu__label">{panel.label}</span>
                  <span className="strategy-menu__hint">{panel.description}</span>
                </button>
              );
            })}
          </nav>
        </aside>
        <div className="strategy-content">
          <div className="strategy-map">
            <MapContainer
              bounds={mapBounds}
              boundsOptions={{ padding: [32, 32] }}
              className="strategy-map__canvas"
              scrollWheelZoom
              preferCanvas
            >
              <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
              <StrategyMapInitializer onReady={handleMapReady} />
              <StrategyDrawingHandler
                enabled={drawingGeofence}
                onPoint={handleGeofencePoint}
                onHover={handleGeofenceHover}
              />
              <SelectedNodeFocus node={selectedNode} />
              {selectedGeofences.map((geofence) =>
                geofence.polygon && geofence.polygon.length > 0 ? (
                  <Polygon
                    key={geofence.id}
                    positions={geofence.polygon.map((vertex) => [vertex.lat, vertex.lon])}
                    pathOptions={{
                      color: geofence.color ?? '#2563eb',
                      weight: 3,
                      fillOpacity: 0.05,
                    }}
                  />
                ) : null,
              )}
              {avoidancePolygons.map((polygon, index) => (
                <Polygon
                  key={`obstacle-${index}`}
                  positions={polygon.map((vertex) => [vertex.lat, vertex.lon])}
                  pathOptions={{ color: '#dc2626', weight: 1, fillOpacity: 0.2, dashArray: '6 6' }}
                />
              ))}
              {anchors.map((anchor) => (
                <Marker
                  key={anchor.id}
                  position={[anchor.lat, anchor.lon]}
                  icon={buildAnchorIcon()}
                >
                  <Tooltip direction="top" offset={[0, -12]} opacity={1} sticky>
                    <strong>{anchor.name}</strong>
                    <div>
                      {anchor.lat.toFixed(5)}, {anchor.lon.toFixed(5)}
                    </div>
                  </Tooltip>
                </Marker>
              ))}
              {strategy.nodes.map((node) => (
                <Marker
                  key={node.id}
                  position={[node.lat, node.lon]}
                  icon={buildStrategyIcon(node)}
                  draggable
                  eventHandlers={{
                    click: () => handleSelectNode(node.id),
                    dragend: (event) => {
                      const marker = event.target as L.Marker;
                      const latLng = marker.getLatLng();
                      handleMarkerDragEnd(node, latLng.lat, latLng.lng);
                    },
                  }}
                >
                  <Tooltip direction="top" offset={[0, -18]} opacity={1} sticky>
                    <div>
                      <strong>{node.displayName ?? node.id}</strong>
                      <div>Profile: {node.profileId}</div>
                      <div>Type: {node.type.toUpperCase()}</div>
                      <div>Radius: {node.radius.toFixed(0)} m</div>
                      <div>Angle: {node.arcWidth.toFixed(0)}&deg;</div>
                      <div>Spacing: {node.spacing.toFixed(0)} m</div>
                      {node.orientation != null ? (
                        <div>Orientation: {node.orientation.toFixed(1)}&deg;</div>
                      ) : null}
                      {node.anchorDistance != null ? (
                        <div>Anchor distance: {node.anchorDistance.toFixed(1)} m</div>
                      ) : null}
                      {node.flags.length > 0 ? <div>Flags: {node.flags.join(', ')}</div> : null}
                    </div>
                  </Tooltip>
                </Marker>
              ))}
              {strategy.nodes.map((node) => (
                <Circle
                  key={`${node.id}-radius`}
                  center={[node.lat, node.lon]}
                  radius={node.radius}
                  pathOptions={{ color: '#2563eb', weight: 1, dashArray: '4 4' }}
                />
              ))}
              {selectedNode ? (
                <Circle
                  key={`${selectedNode.id}-focus`}
                  center={[selectedNode.lat, selectedNode.lon]}
                  radius={selectedNode.radius}
                  pathOptions={{
                    color: '#facc15',
                    weight: 3,
                    dashArray: '2 6',
                    opacity: 0.9,
                  }}
                />
              ) : null}
              {strategy.nodes
                .filter((node) => node.arcWidth < 360 && node.orientation != null)
                .map((node) => {
                  const sector = createSectorPolygon(node);
                  const profile = PROFILE_BY_ID.get(node.profileId);
                  return sector.length > 0 ? (
                    <Polygon
                      key={`${node.id}-sector`}
                      positions={sector}
                      pathOptions={{
                        color: profile?.color ?? '#f97316',
                        weight: 1,
                        fillOpacity: 0.15,
                      }}
                    />
                  ) : null;
                })}
              {strategy.nodes
                .filter((node) => node.orientation != null)
                .map((node) => {
                  const endPoint = projectInDirection(
                    node.lat,
                    node.lon,
                    node.radius * 1.2,
                    node.orientation!,
                  );
                  return (
                    <Polyline
                      key={`${node.id}-orientation`}
                      positions={[[node.lat, node.lon], endPoint]}
                      pathOptions={{ color: '#f97316', weight: 2 }}
                    />
                  );
                })}
              {drawingGeofence && drawingPositions.length > 0 ? (
                <>
                  <Polyline
                    positions={drawingPositions}
                    pathOptions={{ color: '#f97316', dashArray: '6 4', weight: 2 }}
                  />
                  {drawingPositions.length >= 3 ? (
                    <Polygon
                      positions={drawingPositions}
                      pathOptions={{
                        color: '#f97316',
                        weight: 1,
                        fillOpacity: 0.1,
                        dashArray: '8 6',
                      }}
                    />
                  ) : null}
                </>
              ) : null}
            </MapContainer>
            <section className="map-footer__views strategy-map__views">
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
            <div className="map-footer__actions strategy-map__actions">
              <label className="geofence-site-select">
                <span className="geofence-site-select__label">Site</span>
                <select
                  className="control-input"
                  value={selectedSiteId}
                  onChange={(event) => setSelectedSiteId(event.target.value)}
                  aria-label="Site"
                >
                  <option value="">Local site</option>
                  {sitesQueryData?.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name ?? site.id}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={`control-chip${fitEnabled ? '' : ' control-chip--ghost'}`}
                onClick={handleFitClick}
                disabled={!mapReady || !mapRef.current}
              >
                {fitEnabled ? 'Lock View' : 'Fit Geofences'}
              </button>
              <button
                type="button"
                className="submit-button"
                onClick={handleStartGeofenceDrawing}
                disabled={drawingGeofence}
              >
                <MdCropFree /> Create Geofence
              </button>
              {drawingGeofence ? (
                <div className="geofence-drawing-controls">
                  <span>{draftVertices.length} point(s) selected. Click the map to add more.</span>
                  <div className="geofence-drawing-buttons">
                    <button
                      type="button"
                      onClick={handleUndoGeofencePoint}
                      disabled={draftVertices.length === 0}
                    >
                      <MdUndo /> Undo
                    </button>
                    <button type="button" onClick={handleCancelGeofenceDrawing}>
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
          </div>
          {inspectorVisible ? (
            <aside
              className="strategy-node-inspector"
              role={selectedNode ? 'dialog' : 'complementary'}
              aria-modal={selectedNode ? 'false' : undefined}
              aria-labelledby={selectedNode ? inspectorTitleId : panelTitleId}
            >
              {selectedNode ? (
                <>
                  <div className="strategy-node-inspector__header">
                    <div>
                      <h2 id={inspectorTitleId}>{selectedNode.displayName ?? selectedNode.id}</h2>
                      <p>
                        {selectedNode.type.toUpperCase()} - {selectedNode.profileId}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="control-chip control-chip--ghost"
                      onClick={handleCloseInspector}
                    >
                      Close
                    </button>
                  </div>
                  <div className="strategy-node-inspector__body">
                    <div>
                      <span className="muted">Coordinates</span>
                      <div>
                        {selectedNode.lat.toFixed(5)}, {selectedNode.lon.toFixed(5)}
                      </div>
                    </div>
                    {selectedNode.anchorDistance != null ? (
                      <div>
                        <span className="muted">Anchor distance</span>
                        <div>{selectedNode.anchorDistance.toFixed(1)} m</div>
                      </div>
                    ) : null}
                    <label className="form-label" htmlFor={inspectorNameInputId}>
                      Node name
                    </label>
                    <input
                      id={inspectorNameInputId}
                      type="text"
                      className="control-input"
                      value={inspectorNameValue}
                      onChange={handleInspectorNameChange}
                    />
                    <label className="form-label" htmlFor={inspectorProfileSelectId}>
                      Node profile override
                    </label>
                    <select
                      id={inspectorProfileSelectId}
                      className="control-input"
                      value={inspectorProfileValue}
                      onChange={handleInspectorProfileChange}
                    >
                      <option value="">
                        Use plan profile ({baseSelectedNode?.profileId ?? selectedNode.profileId})
                      </option>
                      {NODE_PROFILES.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.label}
                        </option>
                      ))}
                    </select>
                    <p className="form-hint">
                      Mix WiFi, RF, and radar hardware within the same perimeter.
                    </p>
                    <div className="strategy-control strategy-control--stacked">
                      <label className="form-label" htmlFor={inspectorSlideInputId}>
                        Slide along perimeter (m)
                      </label>
                      <input
                        id={inspectorSlideInputId}
                        type="range"
                        min={-SLIDE_RANGE_METERS}
                        max={SLIDE_RANGE_METERS}
                        step={1}
                        value={inspectorSlideValue}
                        onChange={handleInspectorSlideChange}
                      />
                      <div className="muted">{inspectorSlideValue.toFixed(1)} m</div>
                      <p className="form-hint">
                        Positive values move the node forward along the fence line.
                      </p>
                    </div>
                    <div className="strategy-control strategy-control--stacked">
                      <label className="form-label" htmlFor={inspectorNorthInputId}>
                        Move north / south (m)
                      </label>
                      <input
                        id={inspectorNorthInputId}
                        type="range"
                        min={-LATERAL_RANGE_METERS}
                        max={LATERAL_RANGE_METERS}
                        step={1}
                        value={inspectorNorthValue}
                        onChange={handleInspectorNorthChange}
                      />
                      <div className="muted">
                        {inspectorNorthValue >= 0 ? '+' : ''}
                        {inspectorNorthValue.toFixed(1)} m
                      </div>
                      <p className="form-hint">
                        Positive values move the node north; negative values south.
                      </p>
                    </div>
                    <div className="strategy-control strategy-control--stacked">
                      <label className="form-label" htmlFor={inspectorEastInputId}>
                        Move east / west (m)
                      </label>
                      <input
                        id={inspectorEastInputId}
                        type="range"
                        min={-LATERAL_RANGE_METERS}
                        max={LATERAL_RANGE_METERS}
                        step={1}
                        value={inspectorEastValue}
                        onChange={handleInspectorEastChange}
                      />
                      <div className="muted">
                        {inspectorEastValue >= 0 ? '+' : ''}
                        {inspectorEastValue.toFixed(1)} m
                      </div>
                      <p className="form-hint">
                        Positive values move the node east; negative values west.
                      </p>
                    </div>
                    <label className="form-label" htmlFor={inspectorRadiusInputId}>
                      Detection distance (m)
                    </label>
                    <input
                      id={inspectorRadiusInputId}
                      type="number"
                      className="control-input"
                      min={10}
                      max={5000}
                      value={selectedNodeOverride?.radius ?? inspectorRadiusValue}
                      onChange={handleInspectorRadiusChange}
                    />
                    {inspectorSupportsDirection ? (
                      <>
                        <label className="form-label" htmlFor={inspectorOrientationInputId}>
                          Orientation (deg)
                        </label>
                        <input
                          id={inspectorOrientationInputId}
                          type="range"
                          min={0}
                          max={360}
                          step={1}
                          value={selectedNodeOverride?.orientation ?? inspectorOrientationValue}
                          onChange={handleInspectorOrientationChange}
                        />
                        <label className="form-label" htmlFor={inspectorArcInputId}>
                          Sector width (deg)
                        </label>
                        <input
                          id={inspectorArcInputId}
                          type="range"
                          min={20}
                          max={360}
                          step={5}
                          value={selectedNodeOverride?.arcWidth ?? inspectorArcValue}
                          onChange={handleInspectorArcChange}
                        />
                      </>
                    ) : null}
                  </div>
                  <div className="strategy-node-inspector__footer">
                    <button
                      type="button"
                      className="control-chip"
                      onClick={() => handleBookmarkNode(selectedNode)}
                    >
                      Bookmark
                    </button>
                    {inspectorHasOverride ? (
                      <button
                        type="button"
                        className="control-chip control-chip--ghost"
                        onClick={handleInspectorReset}
                      >
                        Reset node overrides
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="control-chip control-chip--danger"
                      onClick={() => handleDeleteNode(selectedNode.id)}
                    >
                      Delete node
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="strategy-node-inspector__header">
                    <div>
                      <h2 id={panelTitleId}>{activePanelDefinition.label}</h2>
                      <p>{activePanelDefinition.description}</p>
                    </div>
                    <button
                      type="button"
                      className="control-chip control-chip--ghost"
                      onClick={handleCloseInspector}
                      aria-label="Close side panel"
                    >
                      Close
                    </button>
                  </div>
                  <div className="strategy-node-inspector__body">{renderActivePanelContent()}</div>
                </>
              )}
            </aside>
          ) : null}
        </div>
      </div>
      {/* end strategy-layout */}

      {planWarnings.length > 0 ? (
        <section className="strategy-warnings">
          <h2>Plan warnings</h2>
          <ul className="strategy-warning-list">
            {planWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="strategy-table">
        <h2>Deployment plan</h2>
        {hasNodes ? (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Name</th>
                <th>Latitude</th>
                <th>Longitude</th>
                <th>Profile</th>
                <th>Type</th>
                <th>Detection (m)</th>
                <th>Spacing (m)</th>
                <th>Orientation (&deg;)</th>
                <th>Angle (&deg;)</th>
                <th>Anchor distance (m)</th>
                <th>Flags</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {strategy.nodes.map((node, index) => {
                const hasOverride = Boolean(nodeOverrides[node.id]);
                const isSelected = node.id === selectedNodeId;
                const rowClassName =
                  [
                    hasOverride ? 'strategy-table__row--override' : null,
                    isSelected ? 'strategy-table__row--selected' : null,
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined;
                return (
                  <tr key={node.id} className={rowClassName}>
                    <td>{index + 1}</td>
                    <td>{node.displayName ?? node.id}</td>
                    <td>{node.lat.toFixed(6)}</td>
                    <td>{node.lon.toFixed(6)}</td>
                    <td>{node.profileId}</td>
                    <td>{node.type.toUpperCase()}</td>
                    <td>{node.radius.toFixed(0)}</td>
                    <td>{node.spacing.toFixed(1)}</td>
                    <td>{node.orientation != null ? node.orientation.toFixed(1) : '--'}</td>
                    <td>{node.arcWidth.toFixed(0)}</td>
                    <td>{node.anchorDistance != null ? node.anchorDistance.toFixed(1) : 'N/A'}</td>
                    <td>{node.flags.length > 0 ? node.flags.join(', ') : '--'}</td>
                    <td>
                      <div className="strategy-row-actions">
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => handleSelectNode(node.id)}
                        >
                          Adjust
                        </button>
                        {hasOverride ? (
                          <button
                            type="button"
                            className="control-chip control-chip--ghost"
                            onClick={() => resetNodeOverride(node.id)}
                          >
                            Reset
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="empty-hint">
            Select a geofence and adjust parameters to generate placements.
          </p>
        )}
      </section>
    </section>
  );
}
function buildStrategy(polygons: GeofenceVertex[][], options: StrategyOptions): StrategyResult {
  const { profile, radius, overlap, offset, avoidancePolygons, anchors, maxAnchorDistance } =
    options;
  const nodes: StrategyNode[] = [];
  let totalPerimeter = 0;
  let spacingAccumulator = 0;
  let nodeCounter = 0;

  polygons.forEach((polygon) => {
    if (polygon.length < 3) {
      return;
    }
    const origin = polygon[0];
    const projected = polygon.map((vertex) => project(vertex, origin));
    const perimeter = computePerimeter(projected);
    if (perimeter === 0) {
      return;
    }

    const desiredSpacing = Math.max(1, 2 * radius - overlap);
    const nodeCount = Math.max(1, Math.round(perimeter / desiredSpacing));
    const effectiveSpacing = perimeter / nodeCount;
    const isCounterClockwise = computeSignedArea(projected) > 0;

    totalPerimeter += perimeter;
    spacingAccumulator += effectiveSpacing;

    for (let index = 0; index < nodeCount; index += 1) {
      const distanceAlong = effectiveSpacing * index;
      const sample = samplePointAlong(projected, distanceAlong);
      const normal = computeNormal(sample.segmentDirection, isCounterClockwise);
      let offsetPoint = {
        x: sample.point.x + normal.x * offset,
        y: sample.point.y + normal.y * offset,
      };
      let latLon = unproject(offsetPoint, origin);
      const flags: string[] = [];

      if (isInsideAnyPolygon(latLon, avoidancePolygons)) {
        let adjusted = offsetPoint;
        let attempts = 0;
        let adjustedLatLon = latLon;
        while (attempts < 4 && isInsideAnyPolygon(adjustedLatLon, avoidancePolygons)) {
          adjusted = {
            x: adjusted.x + normal.x * (radius * 0.5),
            y: adjusted.y + normal.y * (radius * 0.5),
          };
          adjustedLatLon = unproject(adjusted, origin);
          attempts += 1;
        }
        offsetPoint = adjusted;
        latLon = adjustedLatLon;
        if (isInsideAnyPolygon(latLon, avoidancePolygons)) {
          flags.push('obstruction-overlap');
        }
      }

      const anchorInfo = evaluateAnchors(latLon, anchors, maxAnchorDistance);
      if (anchorInfo.flagged) {
        flags.push('anchor-constraint');
      }

      nodeCounter += 1;
      const baseId = `Node ${nodeCounter}`;
      const normalBearing = toBearingDegrees(normal);
      const tangentBearing = toBearingDegrees(sample.segmentDirection);
      const orientation = profile.arcWidth < 360 ? normalBearing : undefined;

      const pathData: NodePathData = {
        origin,
        projected,
        perimeter,
        isCounterClockwise,
        distanceAlong,
        normalShift:
          (offsetPoint.x - sample.point.x) * normal.x + (offsetPoint.y - sample.point.y) * normal.y,
      };

      nodes.push({
        id: baseId,
        displayName: baseId,
        lat: latLon.lat,
        lon: latLon.lon,
        radius,
        spacing: effectiveSpacing,
        overlap,
        type: profile.type,
        profileId: profile.id,
        arcWidth: profile.arcWidth,
        orientation,
        anchorDistance: anchorInfo.distance,
        flags,
        tangentBearing,
        normalBearing,
        path: pathData,
      });
    }
  });

  const averageSpacing =
    nodes.length > 0 ? spacingAccumulator / nodes.length : Math.max(1, 2 * radius - overlap);

  return { nodes, perimeter: totalPerimeter, spacing: averageSpacing };
}

function project(vertex: GeofenceVertex, origin: GeofenceVertex) {
  const latRad = toRad(vertex.lat);
  const lonRad = toRad(vertex.lon);
  const originLatRad = toRad(origin.lat);
  const originLonRad = toRad(origin.lon);
  const x = (lonRad - originLonRad) * Math.cos(originLatRad) * EARTH_RADIUS;
  const y = (latRad - originLatRad) * EARTH_RADIUS;
  return { x, y };
}

function unproject(point: { x: number; y: number }, origin: GeofenceVertex) {
  const originLatRad = toRad(origin.lat);
  const originLonRad = toRad(origin.lon);
  const lat = originLatRad + point.y / EARTH_RADIUS;
  const lon = originLonRad + point.x / (Math.cos(originLatRad) * EARTH_RADIUS);
  return { lat: toDeg(lat), lon: toDeg(lon) };
}

function computePerimeter(points: { x: number; y: number }[]) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return sum;
}

function computeSignedArea(points: { x: number; y: number }[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function samplePointAlong(
  points: { x: number; y: number }[],
  distanceAlong: number,
): {
  point: { x: number; y: number };
  segmentDirection: { x: number; y: number };
} {
  const perimeter = computePerimeter(points);
  let target = distanceAlong % perimeter;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const segmentLength = Math.hypot(next.x - current.x, next.y - current.y);
    if (segmentLength === 0) {
      continue;
    }
    if (target <= segmentLength) {
      const ratio = target / segmentLength;
      const x = current.x + (next.x - current.x) * ratio;
      const y = current.y + (next.y - current.y) * ratio;
      const dir = {
        x: (next.x - current.x) / segmentLength,
        y: (next.y - current.y) / segmentLength,
      };
      return { point: { x, y }, segmentDirection: dir };
    }
    target -= segmentLength;
  }
  const last = points[points.length - 1];
  const first = points[0];
  const segmentLength = Math.hypot(first.x - last.x, first.y - last.y) || 1;
  const dir = {
    x: (first.x - last.x) / segmentLength,
    y: (first.y - last.y) / segmentLength,
  };
  return { point: { ...last }, segmentDirection: dir };
}

function computeNormal(direction: { x: number; y: number }, isCounterClockwise: boolean) {
  if (isCounterClockwise) {
    return { x: -direction.y, y: direction.x };
  }
  return { x: direction.y, y: -direction.x };
}

function evaluateAnchors(
  point: { lat: number; lon: number },
  anchors: AnchorPoint[],
  maxDistance?: number,
) {
  if (anchors.length === 0) {
    return { distance: undefined, flagged: false };
  }
  let best = Number.POSITIVE_INFINITY;
  anchors.forEach((anchor) => {
    const distance = distanceBetween(point.lat, point.lon, anchor.lat, anchor.lon);
    if (distance < best) {
      best = distance;
    }
  });
  if (!Number.isFinite(best)) {
    return { distance: undefined, flagged: false };
  }
  return {
    distance: best,
    flagged: maxDistance != null ? best > maxDistance : false,
  };
}

function isInsideAnyPolygon(point: { lat: number; lon: number }, polygons: AvoidancePolygon[]) {
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

function pointInPolygon(point: { lat: number; lon: number }, polygon: GeofenceVertex[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].lon;
    const yi = polygon[i].lat;
    const xj = polygon[j].lon;
    const yj = polygon[j].lat;
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function extractPolygonsFromGeoJson(document: unknown): AvoidancePolygon[] {
  const polygons: AvoidancePolygon[] = [];

  const toVertices = (coordinates: unknown): GeofenceVertex[] => {
    if (!Array.isArray(coordinates)) {
      return [];
    }
    const vertices: GeofenceVertex[] = [];
    coordinates.forEach((item) => {
      if (Array.isArray(item) && item.length >= 2) {
        const [lon, lat] = item;
        if (typeof lat === 'number' && typeof lon === 'number') {
          vertices.push({ lat, lon });
        }
      }
    });
    return vertices;
  };

  const handleGeometry = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const geometry = raw as {
      type?: string;
      coordinates?: unknown;
      geometries?: unknown;
    };

    switch (geometry.type) {
      case 'Polygon': {
        const coordinates = Array.isArray(geometry.coordinates)
          ? (geometry.coordinates as unknown[])
          : [];
        const vertices = toVertices(coordinates[0]);
        if (vertices.length >= 3) {
          polygons.push(vertices);
        }
        break;
      }
      case 'MultiPolygon': {
        const multi = Array.isArray(geometry.coordinates)
          ? (geometry.coordinates as unknown[])
          : [];
        if (Array.isArray(multi)) {
          multi.forEach((polygonCoords) => {
            const polygonArray = Array.isArray(polygonCoords) ? (polygonCoords as unknown[]) : [];
            const vertices = toVertices(polygonArray[0]);
            if (vertices.length >= 3) {
              polygons.push(vertices);
            }
          });
        }
        break;
      }
      case 'GeometryCollection': {
        const geometries = Array.isArray(geometry.geometries)
          ? (geometry.geometries as unknown[])
          : [];
        if (Array.isArray(geometries)) {
          geometries.forEach(handleGeometry);
        }
        break;
      }
      default:
        break;
    }
  };

  if (document && typeof document === 'object') {
    const geo = document as {
      type?: string;
      features?: unknown;
      geometry?: unknown;
    };
    if (geo.type === 'FeatureCollection') {
      const features = Array.isArray(geo.features) ? (geo.features as unknown[]) : [];
      features.forEach((feature) => {
        if (feature && typeof feature === 'object') {
          const featureGeometry = (feature as { geometry?: unknown }).geometry;
          handleGeometry(featureGeometry);
        }
      });
    } else if (geo.type === 'Feature') {
      handleGeometry(geo.geometry);
    } else {
      handleGeometry(document);
    }
  }

  return polygons;
}

function distanceBetween(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS * c;
}

function toBearingDegrees(vector: { x: number; y: number }) {
  const angle = Math.atan2(vector.y, vector.x);
  const degrees = (angle * 180) / Math.PI;
  return (degrees + 360) % 360;
}

function projectInDirection(lat: number, lon: number, distance: number, bearingDegrees: number) {
  const bearing = toRad(bearingDegrees);
  const latRad = toRad(lat);
  const lonRad = toRad(lon);
  const angularDistance = distance / EARTH_RADIUS;
  const newLat = Math.asin(
    Math.sin(latRad) * Math.cos(angularDistance) +
      Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const newLon =
    lonRad +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
      Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(newLat),
    );
  return [toDeg(newLat), toDeg(newLon)] as [number, number];
}

function createSectorPolygon(node: StrategyNode) {
  if (node.orientation == null || node.arcWidth >= 360) {
    return [];
  }
  const segments = Math.max(6, Math.round(node.arcWidth / 10));
  const halfWidth = node.arcWidth / 2;
  const points: Array<[number, number]> = [[node.lat, node.lon]];
  for (let step = -halfWidth; step <= halfWidth + 0.0001; step += node.arcWidth / segments) {
    const bearing = (node.orientation + step + 360) % 360;
    points.push(projectInDirection(node.lat, node.lon, node.radius, bearing));
  }
  points.push([node.lat, node.lon]);
  return points;
}

function downloadText(filename: string, mimeType: string, content: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.URL.revokeObjectURL(url);
}

function normalizeAlarmLevel(value: string | null): AlarmLevel {
  const normalized = (value ?? '').toUpperCase();
  if (
    normalized === 'INFO' ||
    normalized === 'NOTICE' ||
    normalized === 'ALERT' ||
    normalized === 'CRITICAL'
  ) {
    return normalized;
  }
  return 'ALERT';
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRad(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function toDeg(radians: number) {
  return (radians * 180) / Math.PI;
}

function buildStrategyIcon(node: StrategyNode) {
  const profile = PROFILE_BY_ID.get(node.profileId);
  const baseColor = profile?.color ?? '#2563eb';
  const label = (node.displayName ?? node.id).split(' ').pop();
  return L.divIcon({
    html: `<div class="strategy-node-marker" style="background:${baseColor}">${label}</div>`,
    className: 'strategy-node-wrapper',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function buildAnchorIcon() {
  return L.divIcon({
    html: '<div class="strategy-anchor-marker">A</div>',
    className: 'strategy-anchor-wrapper',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function metersPerDegreeLon(latDegrees: number) {
  return METERS_PER_DEGREE_LAT * Math.cos((latDegrees * Math.PI) / 180);
}

function computeDeltaMeters(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): { north: number; east: number } {
  const north = (toLat - fromLat) * METERS_PER_DEGREE_LAT;
  const meanLat = (fromLat + toLat) / 2;
  const east = (toLon - fromLon) * metersPerDegreeLon(meanLat);
  return { north, east };
}

function StrategyMapInitializer({ onReady }: { onReady: (map: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
  }, [map, onReady]);
  return null;
}

function StrategyDrawingHandler({
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

function SelectedNodeFocus({ node }: { node: StrategyNode | null }) {
  const map = useMap();

  useEffect(() => {
    if (!node) {
      return;
    }
    map.panTo([node.lat, node.lon], { animate: true });
  }, [map, node]);

  return null;
}
