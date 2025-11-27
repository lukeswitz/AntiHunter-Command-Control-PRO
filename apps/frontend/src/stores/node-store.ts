import { create } from 'zustand';

export interface NodeSummary {
  id: string;
  name?: string | null;
  lat: number | null;
  lon: number | null;
  ts: string;
  lastMessage?: string | null;
  lastSeen?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  siteColor?: string | null;
  siteCountry?: string | null;
  siteCity?: string | null;
  temperatureC?: number | null;
  temperatureF?: number | null;
  temperatureUpdatedAt?: string | null;
}

export interface PartialNode {
  id: string;
  name?: string | null;
  lat?: number | string | null;
  lon?: number | string | null;
  ts?: string | number | Date;
  lastMessage?: string | null;
  lastSeen?: string | number | Date | null;
  siteId?: string | null;
  siteName?: string | null;
  siteColor?: string | null;
  siteCountry?: string | null;
  siteCity?: string | null;
  temperatureC?: number | string | null;
  temperatureF?: number | string | null;
  temperatureUpdatedAt?: string | number | Date | null;
}

export type IncomingNode = NodeSummary | PartialNode;

export interface NodeHistoryPoint {
  lat: number | null;
  lon: number | null;
  ts: string;
}

export interface NodeDiffPayload {
  type: 'upsert' | 'remove';
  node: IncomingNode;
}

interface NodeStore {
  nodes: Record<string, NodeSummary>;
  order: string[];
  histories: Record<string, NodeHistoryPoint[]>;
  setInitialNodes: (nodes: IncomingNode[]) => void;
  applyDiff: (diff: NodeDiffPayload) => void;
  updateSiteMeta: (
    siteId: string,
    metadata: {
      name?: string | null;
      color?: string | null;
      country?: string | null;
      city?: string | null;
    },
  ) => void;
  clearAll: () => void;
}

const HISTORY_LIMIT = 50;
const hasValidPosition = (lat: number | null, lon: number | null): boolean =>
  lat !== null &&
  lon !== null &&
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  !(lat === 0 && lon === 0);

export function canonicalNodeId(value: string | null | undefined): string {
  if (!value) {
    return 'NODE_UNKNOWN';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return 'NODE_UNKNOWN';
  }
  const segments = trimmed
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const token = segments.length > 0 ? segments[segments.length - 1] : trimmed;
  const upper = token.toUpperCase();
  if (upper.startsWith('NODE_')) {
    return upper.replace(/[^A-Z0-9_]/g, '');
  }
  if (upper.startsWith('NODE-')) {
    return `NODE_${upper.slice(5).replace(/[^A-Z0-9]/g, '')}`;
  }
  if (upper.startsWith('NODE')) {
    const normalized = upper.slice(4).replace(/[^A-Z0-9]/g, '');
    return normalized ? `NODE_${normalized}` : 'NODE_UNKNOWN';
  }
  if (/^AH[0-9A-Z]+$/.test(upper)) {
    return upper.replace(/[^A-Z0-9]/g, '');
  }
  const sanitized = upper.replace(/[^A-Z0-9]/g, '');
  return sanitized ? `NODE_${sanitized}` : 'NODE_UNKNOWN';
}

export const useNodeStore = create<NodeStore>((set) => ({
  nodes: {},
  order: [],
  histories: {},
  setInitialNodes: (nodes) =>
    set(() => {
      const map: Record<string, NodeSummary> = {};
      const histories: Record<string, NodeHistoryPoint[]> = {};

      nodes.forEach((node) => {
        const normalized = normalizeNode(node);
        map[normalized.id] = normalized;
        histories[normalized.id] = hasValidPosition(normalized.lat, normalized.lon)
          ? [createHistoryPoint(normalized)]
          : [];
      });

      const order = Object.values(map)
        .sort(
          (a, b) => new Date(b.lastSeen ?? b.ts).getTime() - new Date(a.lastSeen ?? a.ts).getTime(),
        )
        .map((node) => node.id);

      return { nodes: map, order, histories };
    }),
  applyDiff: (diff) =>
    set((state) => {
      const next = { ...state.nodes };
      const histories = { ...state.histories };
      const order = new Set(state.order);

      if (diff.type === 'remove') {
        const id = canonicalNodeId(diff.node.id);
        delete next[id];
        delete histories[id];
        order.delete(id);
      } else {
        const normalized = normalizeNode(diff.node);
        next[normalized.id] = normalized;
        order.add(normalized.id);
        const history = histories[normalized.id] ? [...histories[normalized.id]] : [];
        const latest = createHistoryPoint(normalized);
        if (hasValidPosition(latest.lat, latest.lon)) {
          const lastEntry = history.at(-1);
          if (!lastEntry || lastEntry.lat !== latest.lat || lastEntry.lon !== latest.lon) {
            history.push(latest);
          }
        }
        histories[normalized.id] = history.slice(-HISTORY_LIMIT);
      }

      const sortedOrder = Array.from(order).sort((left, right) => {
        const a = next[left];
        const b = next[right];
        const aTime = a ? new Date(a.lastSeen ?? a.ts).getTime() : 0;
        const bTime = b ? new Date(b.lastSeen ?? b.ts).getTime() : 0;
        return bTime - aTime;
      });

      return { nodes: next, histories, order: sortedOrder };
    }),
  updateSiteMeta: (siteId, metadata) =>
    set((state) => {
      if (!siteId) {
        return state;
      }
      const updatedNodes: Record<string, NodeSummary> = {};
      let touched = false;

      for (const [id, node] of Object.entries(state.nodes)) {
        if (node.siteId === siteId) {
          const next: NodeSummary = {
            ...node,
            siteName:
              metadata.name !== undefined ? (metadata.name ?? null) : (node.siteName ?? null),
            siteColor:
              metadata.color !== undefined ? (metadata.color ?? null) : (node.siteColor ?? null),
            siteCountry:
              metadata.country !== undefined
                ? (metadata.country ?? null)
                : (node.siteCountry ?? null),
            siteCity:
              metadata.city !== undefined ? (metadata.city ?? null) : (node.siteCity ?? null),
          };
          updatedNodes[id] = next;
          touched = true;
        }
      }

      if (!touched) {
        return state;
      }

      return {
        ...state,
        nodes: {
          ...state.nodes,
          ...updatedNodes,
        },
      };
    }),
  clearAll: () =>
    set(() => ({
      nodes: {},
      order: [],
      histories: {},
    })),
}));

function normalizeNode(node: IncomingNode): NodeSummary {
  const ensureOptionalNumber = (value: number | string | null | undefined): number | null => {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const ensureIsoString = (value: string | number | Date | null | undefined): string => {
    if (!value) {
      return new Date().toISOString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'number') {
      return new Date(value).toISOString();
    }
    return value;
  };

  const ensureOptionalIsoString = (
    value: string | number | Date | null | undefined,
  ): string | null => {
    if (value == null) {
      return null;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'number') {
      return new Date(value).toISOString();
    }
    return value;
  };

  const canonicalId = canonicalNodeId(node.id);
  const rawName = node.name ?? node.id;
  const nameSegments = rawName
    .split(':')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const normalizedName = nameSegments.length > 0 ? nameSegments[nameSegments.length - 1] : rawName;
  const displayName = normalizedName ? normalizedName : canonicalId;

  return {
    id: canonicalId,
    name: displayName ?? null,
    lat: ensureOptionalNumber(node.lat),
    lon: ensureOptionalNumber(node.lon),
    ts: ensureIsoString(node.ts),
    lastMessage: node.lastMessage ?? null,
    lastSeen: node.lastSeen ? ensureIsoString(node.lastSeen) : null,
    siteId: node.siteId ?? null,
    siteName: node.siteName ?? null,
    siteColor: node.siteColor ?? null,
    siteCountry: node.siteCountry ?? null,
    siteCity: node.siteCity ?? null,
    temperatureC: ensureOptionalNumber(node.temperatureC),
    temperatureF: ensureOptionalNumber(node.temperatureF),
    temperatureUpdatedAt: ensureOptionalIsoString(node.temperatureUpdatedAt),
  };
}

function createHistoryPoint(node: NodeSummary): NodeHistoryPoint {
  return {
    lat: node.lat,
    lon: node.lon,
    ts: node.ts,
  };
}
