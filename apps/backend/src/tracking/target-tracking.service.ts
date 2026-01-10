import { Injectable, Logger } from '@nestjs/common';

import { TargetsService } from '../targets/targets.service';
import { normalizeMac } from '../utils/mac';

const EARTH_RADIUS_M = 6_371_000;
const DETECTION_WINDOW_MS = 45_000;
const PERSIST_INTERVAL_MS = 15_000;
const PERSIST_DISTANCE_M = 8;
const MIN_BOOTSTRAP_CONFIDENCE = 0.25;
const MIN_CONFIDENCE_FOR_PERSIST = 0.35;
const SINGLE_NODE_CONFIDENCE_FLOOR = 0.22;
const MAX_HISTORY_SIZE = 64;

type DetectionSource = 'node' | 'target';

export interface TargetTrackingInput {
  mac: string;
  nodeId?: string;
  nodeLat?: number;
  nodeLon?: number;
  targetLat?: number;
  targetLon?: number;
  rssi?: number;
  siteId?: string | null;
  timestamp?: number;
  detectionTimestamp?: number;
  hdop?: number;
}

interface DetectionEntry {
  nodeId?: string;
  lat: number;
  lon: number;
  nodeLat?: number;
  nodeLon?: number;
  weight: number;
  rssi?: number;
  timestamp: number;
  source: DetectionSource;
  detectionTimestamp?: number; // (microseconds)
  hdop?: number;
}

interface InternalEstimate {
  lat: number;
  lon: number;
  confidence: number;
  timestamp: number;
}

interface TrackingState {
  detections: DetectionEntry[];
  lastEstimate?: InternalEstimate;
  lastPersist?: InternalEstimate;
  siteId?: string | null;
}

interface BaseEstimate {
  lat: number;
  lon: number;
  confidence: number;
  totalWeight: number;
  samples: number;
  uniqueNodes: number;
  spreadMeters: number;
  contributors: Array<{
    nodeId?: string;
    weight: number;
    maxRssi?: number;
    lat?: number;
    lon?: number;
  }>;
}

export interface TrackingEstimate extends BaseEstimate {
  mac: string;
  shouldPersist: boolean;
  siteId?: string | null;
  timestamp: number;
}

@Injectable()
export class TargetTrackingService {
  private readonly logger = new Logger(TargetTrackingService.name);
  private readonly states = new Map<string, TrackingState>();

  constructor(private readonly targetsService: TargetsService) {}

  ingestDetection(input: TargetTrackingInput): TrackingEstimate | null {
    let normalizedMac: string;

    try {
      normalizedMac = normalizeMac(input.mac);
    } catch (error) {
      this.logger.warn(`Skipping tracking update for invalid MAC ${input.mac}: ${String(error)}`);
      return null;
    }

    const nodeLat = this.toFinite(input.nodeLat);
    const nodeLon = this.toFinite(input.nodeLon);
    const measurementLat = this.toFinite(input.targetLat);
    const measurementLon = this.toFinite(input.targetLon);

    // Reject (0, 0) coordinates as invalid
    const nodeIsNullIsland =
      nodeLat !== undefined &&
      nodeLon !== undefined &&
      Math.abs(nodeLat) < 0.0001 &&
      Math.abs(nodeLon) < 0.0001;
    const measurementIsNullIsland =
      measurementLat !== undefined &&
      measurementLon !== undefined &&
      Math.abs(measurementLat) < 0.0001 &&
      Math.abs(measurementLon) < 0.0001;

    if (nodeIsNullIsland || measurementIsNullIsland) {
      return null;
    }

    if (
      measurementLat === undefined &&
      measurementLon === undefined &&
      (nodeLat === undefined || nodeLon === undefined)
    ) {
      return null;
    }

    const latForEntry = measurementLat ?? nodeLat!;
    const lonForEntry = measurementLon ?? nodeLon!;

    const now = input.timestamp ?? Date.now();
    const state = this.states.get(normalizedMac) ?? { detections: [] };

    state.siteId = input.siteId ?? state.siteId ?? null;

    state.detections = state.detections.filter(
      (entry) => now - entry.timestamp <= DETECTION_WINDOW_MS,
    );

    const weight = this.computeWeight(
      input.rssi,
      measurementLat !== undefined && measurementLon !== undefined,
    );

    const detection: DetectionEntry = {
      nodeId: input.nodeId,
      lat: latForEntry,
      lon: lonForEntry,
      nodeLat: nodeLat,
      nodeLon: nodeLon,
      weight,
      rssi: this.toFinite(input.rssi),
      timestamp: now,
      source: (measurementLat !== undefined && measurementLon !== undefined
        ? 'target'
        : 'node') as DetectionSource,
      detectionTimestamp: this.toFinite(input.detectionTimestamp),
      hdop: this.toFinite(input.hdop),
    };

    state.detections.push(detection);

    if (input.detectionTimestamp !== undefined) {
      this.logger.debug(
        `Ingested detection for ${normalizedMac} from node ${input.nodeId}: RSSI=${input.rssi}, detectionTimestamp=${input.detectionTimestamp}μs, nodeLat=${nodeLat}, nodeLon=${nodeLon}`,
      );
    }

    if (state.detections.length > MAX_HISTORY_SIZE) {
      state.detections.splice(0, state.detections.length - MAX_HISTORY_SIZE);
    }

    const baseEstimate = this.buildEstimate(state);
    if (!baseEstimate) {
      this.pruneStateIfIdle(normalizedMac, state, now);
      return null;
    }

    const estimate: TrackingEstimate = {
      ...baseEstimate,
      mac: normalizedMac,
      shouldPersist: false,
      siteId: state.siteId ?? null,
      timestamp: now,
    };

    const smoothed = this.applySmoothing(state, estimate);
    estimate.lat = smoothed.lat;
    estimate.lon = smoothed.lon;
    estimate.confidence = smoothed.confidence;

    const persistence = this.evaluatePersistence(state, estimate);
    estimate.shouldPersist = persistence.shouldPersist;

    state.lastEstimate = {
      lat: estimate.lat,
      lon: estimate.lon,
      confidence: estimate.confidence,
      timestamp: now,
    };

    this.states.set(normalizedMac, state);

    return estimate;
  }

  async persistEstimate(mac: string, estimate: TrackingEstimate): Promise<void> {
    const state = this.states.get(mac);
    if (!state) {
      return;
    }

    try {
      const updated = await this.targetsService.applyTrackingEstimate(
        mac,
        estimate.lat,
        estimate.lon,
        estimate.siteId ?? undefined,
        estimate.confidence,
        estimate.spreadMeters,
        undefined, // Method determined by firmware, not tracking service
      );

      if (updated) {
        state.lastPersist = {
          lat: estimate.lat,
          lon: estimate.lon,
          confidence: estimate.confidence,
          timestamp: Date.now(),
        };
      }
    } catch (error) {
      this.logger.warn(`Unable to persist tracking estimate for ${mac}: ${String(error)}`);
    }
  }

  private buildEstimate(state: TrackingState): BaseEstimate | null {
    const { detections } = state;
    if (!detections.length) {
      return null;
    }

    // Simple RSSI-based position estimation
    // Note: This is for continuous tracking, NOT triangulation
    // Triangulation is done by firmware and received via T_F messages
    const rssiEstimate = this.tryRSSIEstimate(state);

    if (!rssiEstimate) {
      return null;
    }

    return rssiEstimate;
  }

  private tryRSSIEstimate(state: TrackingState): BaseEstimate | null {
    const { detections } = state;
    if (!detections.length) {
      return null;
    }

    const totalWeight = detections.reduce((sum, entry) => sum + entry.weight, 0);
    if (totalWeight <= 0) {
      return null;
    }

    const rawLat =
      detections.reduce((sum, entry) => sum + entry.lat * entry.weight, 0) / totalWeight;
    const rawLon =
      detections.reduce((sum, entry) => sum + entry.lon * entry.weight, 0) / totalWeight;

    const clampedLat = this.clampLatitude(rawLat);
    const clampedLon = this.clampLongitude(rawLon);

    const uniqueNodes = new Set<string>();
    const contributorMap = new Map<
      string,
      { nodeId?: string; weight: number; maxRssi?: number; lat?: number; lon?: number }
    >();

    let weightedDistanceSq = 0;

    detections.forEach((entry) => {
      const key = entry.nodeId ?? `__node_${entry.lat.toFixed(5)}:${entry.lon.toFixed(5)}`;
      uniqueNodes.add(key);

      const aggregate = contributorMap.get(key) ?? {
        nodeId: entry.nodeId,
        weight: 0,
        maxRssi: entry.rssi,
        lat: entry.nodeLat ?? entry.lat,
        lon: entry.nodeLon ?? entry.lon,
      };
      if (
        (aggregate.lat === undefined || aggregate.lon === undefined) &&
        entry.nodeLat !== undefined &&
        entry.nodeLon !== undefined
      ) {
        aggregate.lat = entry.nodeLat;
        aggregate.lon = entry.nodeLon;
      }
      aggregate.weight += entry.weight;
      if (entry.rssi !== undefined) {
        aggregate.maxRssi =
          aggregate.maxRssi !== undefined ? Math.max(aggregate.maxRssi, entry.rssi) : entry.rssi;
      }
      contributorMap.set(key, aggregate);

      const distance = this.distanceMeters(entry.lat, entry.lon, clampedLat, clampedLon);
      weightedDistanceSq += entry.weight * distance * distance;
    });

    const spreadMeters = weightedDistanceSq > 0 ? Math.sqrt(weightedDistanceSq / totalWeight) : 0;

    const nodeFactor = Math.min(1, uniqueNodes.size / 3);
    const weightFactor = Math.min(1, totalWeight / (uniqueNodes.size * 0.9 + 0.3));
    const spreadFactor = 1 / (1 + spreadMeters / 120);

    const confidence = this.clamp01(nodeFactor * weightFactor * spreadFactor);

    const contributors = Array.from(contributorMap.values())
      .map((entry) => ({
        nodeId: entry.nodeId,
        weight: Number(entry.weight.toFixed(3)),
        maxRssi: entry.maxRssi !== undefined ? Number(entry.maxRssi.toFixed(1)) : undefined,
        lat: entry.lat !== undefined ? Number(entry.lat.toFixed(6)) : undefined,
        lon: entry.lon !== undefined ? Number(entry.lon.toFixed(6)) : undefined,
      }))
      .sort((a, b) => b.weight - a.weight);

    return {
      lat: clampedLat,
      lon: clampedLon,
      confidence,
      totalWeight,
      samples: detections.length,
      uniqueNodes: uniqueNodes.size,
      spreadMeters,
      contributors,
    };
  }

  private applySmoothing(state: TrackingState, estimate: TrackingEstimate) {
    const previous = state.lastEstimate;
    if (!previous) {
      return estimate;
    }

    const totalWeight = Math.max(estimate.totalWeight, 0.01);
    const baseSmoothing = Math.min(0.85, Math.max(0.25, totalWeight / (estimate.samples + 0.35)));
    const smoothing = Math.max(baseSmoothing, Math.min(0.9, previous.confidence + 0.15));

    const lat = previous.lat + (estimate.lat - previous.lat) * smoothing;
    const lon = previous.lon + (estimate.lon - previous.lon) * smoothing;
    const confidence = this.clamp01(
      (previous.confidence + estimate.confidence * smoothing) / (1 + smoothing),
    );

    return {
      ...estimate,
      lat: this.clampLatitude(lat),
      lon: this.clampLongitude(lon),
      confidence,
    };
  }

  private evaluatePersistence(state: TrackingState, estimate: TrackingEstimate) {
    const lastPersist = state.lastPersist;

    if (!lastPersist) {
      return { shouldPersist: estimate.confidence >= MIN_BOOTSTRAP_CONFIDENCE };
    }

    const deltaMeters = this.distanceMeters(
      lastPersist.lat,
      lastPersist.lon,
      estimate.lat,
      estimate.lon,
    );
    const elapsed = estimate.timestamp - lastPersist.timestamp;

    if (estimate.confidence < MIN_CONFIDENCE_FOR_PERSIST) {
      const relaxed = elapsed >= PERSIST_INTERVAL_MS * 2 && deltaMeters >= PERSIST_DISTANCE_M * 2;
      return { shouldPersist: relaxed };
    }

    if (estimate.uniqueNodes <= 1 && estimate.confidence < SINGLE_NODE_CONFIDENCE_FLOOR) {
      const relaxed = elapsed >= PERSIST_INTERVAL_MS * 2 && deltaMeters >= PERSIST_DISTANCE_M * 2;
      return { shouldPersist: relaxed };
    }

    const shouldPersist = deltaMeters >= PERSIST_DISTANCE_M || elapsed >= PERSIST_INTERVAL_MS;

    return { shouldPersist };
  }

  private pruneStateIfIdle(mac: string, state: TrackingState, now: number) {
    if (
      !state.detections.length &&
      (!state.lastEstimate || now - state.lastEstimate.timestamp > DETECTION_WINDOW_MS)
    ) {
      this.states.delete(mac);
    } else {
      this.states.set(mac, state);
    }
  }

  private computeWeight(rssi?: number, favorMeasurement = false): number {
    if (typeof rssi !== 'number' || !Number.isFinite(rssi)) {
      return favorMeasurement ? 1.2 : 0.6;
    }
    const clamped = Math.max(-120, Math.min(-35, rssi));
    const normalized = (clamped + 120) / 85; // 0..1
    const base = Math.max(0.05, Math.pow(normalized, 2.2));
    return favorMeasurement ? base * 1.6 + 0.2 : base + 0.1;
  }

  private toFinite(value?: number | null): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }
    return value;
  }

  private clampLatitude(lat: number): number {
    return Math.max(-90, Math.min(90, lat));
  }

  private clampLongitude(lon: number): number {
    if (!Number.isFinite(lon)) {
      return 0;
    }
    let normalized = lon;
    while (normalized > 180) {
      normalized -= 360;
    }
    while (normalized < -180) {
      normalized += 360;
    }
    return normalized;
  }

  private distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_M * c;
  }

  private toRadians(value: number): number {
    return (value * Math.PI) / 180;
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(1, value));
  }
}
