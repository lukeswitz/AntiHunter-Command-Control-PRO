import { useQuery } from '@tanstack/react-query';
import L, { latLngBounds } from 'leaflet';
import { ChangeEvent, FormEvent, useEffect, useId, useMemo, useState } from 'react';
import {
  Circle,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from 'react-leaflet';

import { apiClient } from '../api/client';
import type { Geofence, GeofenceVertex, InventoryDevice } from '../api/types';
import { useGeofenceStore } from '../stores/geofence-store';

const DEFAULT_RADIUS = 200;
const DEFAULT_OVERLAP = 0;
const EARTH_RADIUS = 6_371_000;
const CUSTOM_PRESET_ID = 'custom';
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors';

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
    defaultRadius: 240,
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
    radius: 240,
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

interface InventoryRow {
  type: string;
  required: number;
  available: number;
}

interface NodeOverride {
  radius?: number;
  orientation?: number;
  arcWidth?: number;
}

export function StrategyAdvisorPage() {
  const geofences = useGeofenceStore((state) => state.geofences);
  const loadGeofences = useGeofenceStore((state) => state.loadGeofences);

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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

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
  const inspectorRadiusInputId = `${idBase}-inspector-radius`;
  const inspectorOrientationInputId = `${idBase}-inspector-orientation`;
  const inspectorArcInputId = `${idBase}-inspector-arc`;

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
    const nodes = baseStrategy.nodes.map((node) => {
      const override = nodeOverrides[node.id];
      if (!override) {
        return node;
      }
      const nextOrientation =
        override.orientation != null
          ? ((override.orientation % 360) + 360) % 360
          : node.orientation;
      const nextArcWidth =
        override.arcWidth != null ? Math.min(360, Math.max(10, override.arcWidth)) : node.arcWidth;
      const nextRadius = override.radius != null ? Math.max(1, override.radius) : node.radius;
      return {
        ...node,
        orientation: nextOrientation,
        arcWidth: nextArcWidth,
        radius: nextRadius,
      };
    });
    return { ...baseStrategy, nodes };
  }, [baseStrategy, nodeOverrides]);

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

  const { data: inventoryData } = useQuery({
    queryKey: ['inventory', 'strategy-advisor'],
    queryFn: async () => apiClient.get<InventoryDevice[]>('/inventory'),
    staleTime: 120_000,
  });

  const inventoryReport = useMemo<InventoryRow[]>(() => {
    if (!inventoryData || inventoryData.length === 0 || strategy.nodes.length === 0) {
      return [];
    }
    const available = new Map<string, number>();
    inventoryData.forEach((device) => {
      const key = (device.type ?? 'unknown').toLowerCase();
      available.set(key, (available.get(key) ?? 0) + 1);
    });

    const required = new Map<string, number>();
    strategy.nodes.forEach((node) => {
      const key = node.type.toLowerCase();
      required.set(key, (required.get(key) ?? 0) + 1);
    });

    return Array.from(required.entries()).map(([type, needed]) => ({
      type,
      required: needed,
      available: available.get(type) ?? 0,
    }));
  }, [inventoryData, strategy.nodes]);

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
    inventoryReport.forEach((row) => {
      if (row.required > row.available) {
        warnings.add(
          `Inventory shortage for ${row.type.toUpperCase()}: need ${row.required}, available ${row.available}.`,
        );
      }
    });
    return Array.from(warnings);
  }, [selectedGeofences.length, strategy.nodes, inventoryReport]);

  const hasNodes = strategy.nodes.length > 0;
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

  const panelClass = (...panels: StrategyPanelId[]) =>
    panels.includes(activePanel) ? 'strategy-panel' : 'strategy-panel strategy-panel--hidden';

  const updateNodeOverride = (nodeId: string, changes: NodeOverride) => {
    const baseNode = baseNodeLookup.get(nodeId);
    if (!baseNode) {
      return;
    }
    setNodeOverrides((previous) => {
      const current = previous[nodeId] ?? {};
      const next: NodeOverride = { ...current };

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

      if (next.radius !== undefined && next.radius === baseNode.radius) {
        delete next.radius;
      }
      if (next.orientation !== undefined && next.orientation === baseNode.orientation) {
        delete next.orientation;
      }
      if (next.arcWidth !== undefined && next.arcWidth === baseNode.arcWidth) {
        delete next.arcWidth;
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
  };

  const handleCloseInspector = () => {
    setSelectedNodeId(null);
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

  const handleExportCsv = () => {
    if (!hasNodes) {
      return;
    }
    const lines = [
      'Name,Latitude,Longitude,Type,Profile,RadiusMeters,OverlapMeters,SpacingMeters,OrientationDegrees,ArcWidthDegrees,AnchorDistanceMeters,Flags',
      ...strategy.nodes.map((node) =>
        [
          node.id,
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
      <name>${node.id}</name>
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
          <h1 className="panel__title">Strategy Advisor</h1>
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
              return (
                <button
                  key={panel.id}
                  type="button"
                  className={`strategy-menu__item${isActive ? ' is-active' : ''}`}
                  aria-pressed={isActive}
                  onClick={() => setActivePanel(panel.id)}
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
              <MapBoundsUpdater bounds={mapBounds} enabled={selectedGeofences.length > 0} />
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
                  eventHandlers={{
                    click: () => handleSelectNode(node.id),
                  }}
                >
                  <Tooltip direction="top" offset={[0, -18]} opacity={1} sticky>
                    <div>
                      <strong>{node.id}</strong>
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
            </MapContainer>
          </div>
          <div className="strategy-panels">
            <div className={panelClass('plan')}>
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
                  Presets apply recommended radius, overlap, and offsets. Any manual change switches
                  to the Custom profile.
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
            </div>

            <div className={panelClass('areas')}>
              <div className="form-section">
                <span className="form-label" id={geofenceCheckboxGroupId}>
                  Geofences to include
                </span>
                <div
                  className="geofence-checkboxes"
                  role="group"
                  aria-labelledby={geofenceCheckboxGroupId}
                >
                  {geofences.length === 0 ? (
                    <p className="form-hint">
                      No geofences available. Create one on the Geofences page.
                    </p>
                  ) : (
                    geofences.map((geofence) => (
                      <label key={geofence.id} className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={selectedGeofenceIds.includes(geofence.id)}
                          onChange={(event) =>
                            handleGeofenceToggle(geofence.id, event.target.checked)
                          }
                        />
                        <span>
                          {geofence.name}{' '}
                          <span className="muted">
                            (
                            {geofence.polygon
                              ? `${geofence.polygon.length} vertices`
                              : 'no polygon'}
                            )
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
                  Anchors represent power or network drops. Nodes exceeding the max distance from
                  the nearest anchor are flagged for review.
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
                      placeholder="Roof drop, mast, etc."
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
                    Upload polygons representing no-go areas (buildings, water, etc.). Nodes close
                    to or within these areas are adjusted automatically.
                  </p>
                )}
                {avoidancePolygons.length > 0 ? (
                  <div className="strategy-obstacles__actions">
                    <span className="muted">
                      {avoidancePolygons.length} exclusion zone(s) active.
                    </span>
                    <button type="button" className="control-chip" onClick={handleObstacleClear}>
                      Clear exclusions
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <div className={panelClass('summary')}>
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
            </div>
          </div>
        </div>
      </div>
      {selectedNode ? (
        <aside
          className="strategy-node-inspector"
          role="dialog"
          aria-modal="false"
          aria-labelledby={inspectorTitleId}
        >
          <div className="strategy-node-inspector__header">
            <div>
              <h2 id={inspectorTitleId}>{selectedNode.id}</h2>
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
            <label className="form-label" htmlFor={inspectorRadiusInputId}>
              Detection distance (m)
            </label>
            <input
              id={inspectorRadiusInputId}
              type="number"
              className="control-input"
              min={10}
              max={5000}
              step={1}
              value={inspectorRadiusValue}
              onChange={handleInspectorRadiusChange}
            />
            <p className="form-hint">
              Base distance:{' '}
              {baseSelectedNode ? `${baseSelectedNode.radius.toFixed(0)} m` : 'not available'}
              {inspectorHasOverride ? ' | Override active' : ''}
            </p>
            {inspectorSupportsDirection ? (
              <>
                <label className="form-label" htmlFor={inspectorOrientationInputId}>
                  Orientation (degrees)
                </label>
                <input
                  id={inspectorOrientationInputId}
                  type="number"
                  className="control-input"
                  min={0}
                  max={359}
                  step={1}
                  value={inspectorOrientationValue}
                  onChange={handleInspectorOrientationChange}
                />
                <label className="form-label" htmlFor={inspectorArcInputId}>
                  Beam angle (degrees)
                </label>
                <input
                  id={inspectorArcInputId}
                  type="number"
                  className="control-input"
                  min={10}
                  max={360}
                  step={1}
                  value={inspectorArcValue}
                  onChange={handleInspectorArcChange}
                />
              </>
            ) : (
              <p className="form-hint">
                Omni-directional node. Orientation and beam angle are not applicable.
              </p>
            )}
          </div>
          <div className="strategy-node-inspector__footer">
            {inspectorHasOverride ? (
              <button
                type="button"
                className="control-chip control-chip--ghost"
                onClick={() => resetNodeOverride(selectedNode.id)}
              >
                Reset overrides
              </button>
            ) : null}
            <button
              type="button"
              className="control-chip control-chip--ghost"
              onClick={handleCloseInspector}
            >
              Done
            </button>
          </div>
        </aside>
      ) : null}

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

      {inventoryReport.length > 0 ? (
        <section className="strategy-inventory">
          <h2>Inventory check</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Required</th>
                <th>Available</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {inventoryReport.map((row) => (
                <tr
                  key={row.type}
                  className={
                    row.available < row.required ? 'strategy-inventory__row--warning' : undefined
                  }
                >
                  <td>{row.type.toUpperCase()}</td>
                  <td>{row.required}</td>
                  <td>{row.available}</td>
                  <td>{row.available >= row.required ? 'Ready' : 'Shortage'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="strategy-table">
        <h2>Node placement plan</h2>
        {hasNodes ? (
          <table>
            <thead>
              <tr>
                <th>#</th>
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

      const orientation = profile.arcWidth < 360 ? toBearingDegrees(normal) : undefined;

      nodes.push({
        id: `Node ${++nodeCounter}`,
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
  return L.divIcon({
    html: `<div class="strategy-node-marker" style="background:${baseColor}">${node.id
      .split(' ')
      .pop()}</div>`,
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

function MapBoundsUpdater({ bounds, enabled }: { bounds: L.LatLngBounds; enabled: boolean }) {
  const map = useMap();

  useEffect(() => {
    if (!enabled || !bounds.isValid()) {
      return;
    }
    map.fitBounds(bounds, { padding: [32, 32] });
  }, [map, bounds, enabled]);

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
