import { Injectable, Logger } from '@nestjs/common';

import { TargetsService } from '../targets/targets.service';
import { normalizeMac } from '../utils/mac';

const EARTH_RADIUS_M = 6_371_000;
const SPEED_OF_LIGHT_M_PER_S = 299_792_458; // meters per second
const DETECTION_WINDOW_MS = 45_000;
const PERSIST_INTERVAL_MS = 15_000;
const PERSIST_DISTANCE_M = 8;
const MIN_BOOTSTRAP_CONFIDENCE = 0.05;
const MIN_CONFIDENCE_FOR_PERSIST = 0.1;
const SINGLE_NODE_CONFIDENCE_FLOOR = 0.08;
const MAX_HISTORY_SIZE = 64;
const MIN_NODES_FOR_TDOA = 3;

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
  method?: 'tdoa' | 'rssi' | 'hybrid';
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
        estimate.method,
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

    // Try TDOA first if we have enough nodes with timestamps
    const tdoaEstimate = this.tryTDOAEstimate(state);
    const rssiEstimate = this.tryRSSIEstimate(state);

    // Hybrid approach: combine TDOA and RSSI if both available
    if (tdoaEstimate && rssiEstimate) {
      this.logger.debug(
        `Using hybrid triangulation (TDOA + RSSI) with ${tdoaEstimate.uniqueNodes} nodes`,
      );
      return this.combineEstimates(tdoaEstimate, rssiEstimate);
    }

    if (tdoaEstimate) {
      this.logger.debug(
        `Using TDOA triangulation with ${tdoaEstimate.uniqueNodes} nodes, confidence: ${(tdoaEstimate.confidence * 100).toFixed(1)}%`,
      );
    } else if (rssiEstimate) {
      this.logger.debug(
        `Using RSSI triangulation with ${rssiEstimate.uniqueNodes} nodes, confidence: ${(rssiEstimate.confidence * 100).toFixed(1)}%`,
      );
    }

    // Fallback to whichever method succeeded
    return tdoaEstimate ?? rssiEstimate;
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
      method: 'rssi',
      contributors,
    };
  }

  /**
   * TDOA (Time Difference of Arrival) Triangulation
   * Uses GPS-synchronized timestamps to calculate target position
   */
  private tryTDOAEstimate(state: TrackingState): BaseEstimate | null {
    const { detections } = state;

    // Filter detections with valid timestamps and GPS coordinates
    const validDetections = detections.filter(
      (d) =>
        d.detectionTimestamp !== undefined &&
        d.nodeLat !== undefined &&
        d.nodeLon !== undefined &&
        d.nodeId !== undefined,
    );

    if (validDetections.length < MIN_NODES_FOR_TDOA) {
      return null;
    }

    // Sort by detection timestamp
    validDetections.sort((a, b) => a.detectionTimestamp! - b.detectionTimestamp!);

    // Use earliest detection as reference
    const reference = validDetections[0];
    const refLat = reference.nodeLat!;
    const refLon = reference.nodeLon!;
    const refTime = reference.detectionTimestamp!;

    // Calculate TDOA measurements
    interface TDOANode {
      lat: number;
      lon: number;
      rangeDiff: number;
      weight: number;
      nodeId: string;
      rssi?: number;
    }

    const tdoaNodes: TDOANode[] = [];

    for (let i = 1; i < validDetections.length; i++) {
      const detection = validDetections[i];
      const timeDiff = (detection.detectionTimestamp! - refTime) / 1_000_000; // Convert μs to seconds
      const rangeDiff = timeDiff * SPEED_OF_LIGHT_M_PER_S;

      // Weight based on signal quality, GPS accuracy, and clock synchronization
      const baseWeight = detection.weight ?? 1.0;

      // HDOP weight: lower HDOP = better GPS accuracy = higher weight
      // Typical HDOP values: <2 (excellent), 2-5 (good), 5-10 (moderate), >10 (poor)
      const hdopWeight = detection.hdop !== undefined
        ? Math.max(0.3, 1.0 / (1.0 + detection.hdop / 2.5))  // Normalize around HDOP=2.5
        : 0.7; // Default if HDOP unavailable

      // Clock sync weight: GPS-disciplined clocks have microsecond precision
      // High weight for valid timestamps (indicates GPS-synced RTC)
      const clockSyncWeight = 1.0;

      const finalWeight = baseWeight * hdopWeight * clockSyncWeight;

      this.logger.debug(
        `TDOA node ${detection.nodeId}: timeDiff=${(timeDiff * 1000).toFixed(3)}ms, rangeDiff=${rangeDiff.toFixed(1)}m, ` +
        `timestamp=${detection.detectionTimestamp}μs, hdop=${detection.hdop?.toFixed(2) ?? 'N/A'}, weight=${finalWeight.toFixed(3)}`,
      );

      // Warn if range difference is unrealistic (suggests timestamp conversion issue)
      if (Math.abs(rangeDiff) > 100_000) {
        // 100km threshold
        this.logger.warn(
          `TDOA: Suspicious range difference of ${(rangeDiff / 1000).toFixed(1)}km detected. ` +
            `This may indicate incorrect timestamp conversion (TS field multiplier). ` +
            `Time diff: ${(timeDiff * 1000).toFixed(3)}ms between nodes ${reference.nodeId} and ${detection.nodeId}`,
        );
      }

      tdoaNodes.push({
        lat: detection.nodeLat!,
        lon: detection.nodeLon!,
        rangeDiff,
        weight: finalWeight,
        nodeId: detection.nodeId!,
        rssi: detection.rssi,
      });
    }

    // Weighted Least Squares TDOA solution
    const result = this.solveTDOA(refLat, refLon, tdoaNodes);

    if (!result) {
      return null;
    }

    // Build contributors array
    const contributors = [
      {
        nodeId: reference.nodeId,
        weight: reference.weight,
        maxRssi: reference.rssi,
        lat: refLat,
        lon: refLon,
      },
      ...tdoaNodes.map((node) => ({
        nodeId: node.nodeId,
        weight: Number(node.weight.toFixed(3)),
        maxRssi: node.rssi,
        lat: Number(node.lat.toFixed(6)),
        lon: Number(node.lon.toFixed(6)),
      })),
    ];

    const uniqueNodes = new Set(contributors.map((c) => c.nodeId));

    return {
      lat: result.lat,
      lon: result.lon,
      confidence: result.confidence,
      totalWeight: tdoaNodes.reduce((sum, n) => sum + n.weight, reference.weight),
      samples: validDetections.length,
      uniqueNodes: uniqueNodes.size,
      spreadMeters: result.spreadMeters,
      method: 'tdoa',
      contributors,
    };
  }

  private solveTDOA(
    refLat: number,
    refLon: number,
    nodes: Array<{ lat: number; lon: number; rangeDiff: number; weight: number }>,
  ): { lat: number; lon: number; confidence: number; spreadMeters: number } | null {
    if (nodes.length < 2) {
      return null;
    }

    const nodePositions = [{ lat: refLat, lon: refLon }, ...nodes];
    const avgNodeDistance =
      nodePositions.reduce((sum, n1, i) => {
        return (
          sum +
          nodePositions
            .slice(i + 1)
            .reduce((s, n2) => s + this.distanceMeters(n1.lat, n1.lon, n2.lat, n2.lon), 0)
        );
      }, 0) /
      ((nodePositions.length * (nodePositions.length - 1)) / 2);

    const environment = this.detectEnvironment(avgNodeDistance, nodes.length);

    let workingNodes = [...nodes];
    const maxIterations = 15;
    const convergenceThreshold = 0.1;

    const totalWeight = workingNodes.reduce((sum, n) => sum + n.weight, 1);
    let estLat =
      (refLat + workingNodes.reduce((sum, n) => sum + n.lat * n.weight, 0)) / totalWeight;
    let estLon =
      (refLon + workingNodes.reduce((sum, n) => sum + n.lon * n.weight, 0)) / totalWeight;

    for (let iter = 0; iter < maxIterations; iter++) {
      let sumH11 = 0,
        sumH12 = 0,
        sumH22 = 0;
      let sumG1 = 0,
        sumG2 = 0;

      const r0 = this.distanceMeters(estLat, estLon, refLat, refLon);
      const residuals: number[] = [];

      for (const node of workingNodes) {
        const ri = this.distanceMeters(estLat, estLon, node.lat, node.lon);
        const expectedDiff = ri - r0;
        const residual = node.rangeDiff - expectedDiff;
        residuals.push(Math.abs(residual));

        const deltaLat = 0.00001;
        const deltaLon = 0.00001;

        const r0_dLat = this.distanceMeters(estLat + deltaLat, estLon, refLat, refLon);
        const ri_dLat = this.distanceMeters(estLat + deltaLat, estLon, node.lat, node.lon);
        const dLat = (ri_dLat - r0_dLat - expectedDiff) / deltaLat;

        const r0_dLon = this.distanceMeters(estLat, estLon + deltaLon, refLat, refLon);
        const ri_dLon = this.distanceMeters(estLat, estLon + deltaLon, node.lat, node.lon);
        const dLon = (ri_dLon - r0_dLon - expectedDiff) / deltaLon;

        const w = node.weight;
        sumH11 += w * dLat * dLat;
        sumH12 += w * dLat * dLon;
        sumH22 += w * dLon * dLon;
        sumG1 += w * dLat * residual;
        sumG2 += w * dLon * residual;
      }

      if (iter > 3 && workingNodes.length >= 4) {
        const medianResidual = this.median(residuals);
        const mad = this.median(residuals.map((r) => Math.abs(r - medianResidual)));
        const threshold = medianResidual + 3 * mad * 1.4826;

        const filtered = workingNodes.filter((node, idx) => residuals[idx] <= threshold);
        if (filtered.length >= MIN_NODES_FOR_TDOA) {
          workingNodes = filtered;
        }
      }

      const det = sumH11 * sumH22 - sumH12 * sumH12;
      if (Math.abs(det) < 1e-10) {
        break;
      }

      const deltaLat = (sumH22 * sumG1 - sumH12 * sumG2) / det;
      const deltaLon = (sumH11 * sumG2 - sumH12 * sumG1) / det;

      estLat += deltaLat;
      estLon += deltaLon;

      const deltaMeters = Math.sqrt(
        Math.pow(deltaLat * 111320, 2) +
          Math.pow(deltaLon * 111320 * Math.cos(this.toRadians(estLat)), 2),
      );

      if (deltaMeters < convergenceThreshold) {
        break;
      }
    }

    const r0Final = this.distanceMeters(estLat, estLon, refLat, refLon);
    let sumWeightedError = 0;
    let sumWeights = 0;
    const errors: number[] = [];

    for (const node of workingNodes) {
      const ri = this.distanceMeters(estLat, estLon, node.lat, node.lon);
      const expectedDiff = ri - r0Final;
      const error = Math.abs(node.rangeDiff - expectedDiff);
      errors.push(error);
      sumWeightedError += node.weight * error;
      sumWeights += node.weight;
    }

    const avgError = sumWeights > 0 ? sumWeightedError / sumWeights : 1000;
    const medianError = this.median(errors);
    const spreadMeters = Math.min(avgError, medianError * 1.5);

    const envFactor = environment === 'urban' ? 0.7 : environment === 'suburban' ? 0.85 : 1.0;
    // Tighter error thresholds for GPS-disciplined clock precision (microsecond timestamps)
    const errorThreshold = environment === 'urban' ? 75 : environment === 'suburban' ? 50 : 35;
    const errorFactor = envFactor / (1 + spreadMeters / errorThreshold);
    const nodeFactor = Math.min(1, workingNodes.length / 4);
    const gdopFactor = this.calculateGDOP(refLat, refLon, workingNodes);
    // Boost confidence slightly due to GPS-synced timestamps (0.95 → 0.98)
    const confidence = this.clamp01(errorFactor * nodeFactor * gdopFactor * 0.98);

    return {
      lat: this.clampLatitude(estLat),
      lon: this.clampLongitude(estLon),
      confidence,
      spreadMeters,
    };
  }

  private detectEnvironment(avgNodeDistance: number, nodeCount: number): string {
    const density = nodeCount / Math.max(1, avgNodeDistance / 1000);
    if (density > 5 || avgNodeDistance < 500) {
      return 'urban';
    } else if (density > 2 || avgNodeDistance < 1500) {
      return 'suburban';
    }
    return 'rural';
  }

  private calculateGDOP(
    refLat: number,
    refLon: number,
    nodes: Array<{ lat: number; lon: number }>,
  ): number {
    if (nodes.length < 2) {
      return 0.5;
    }
    const angles: number[] = [];
    for (const node of nodes) {
      const dLat = node.lat - refLat;
      const dLon = node.lon - refLon;
      angles.push(Math.atan2(dLon, dLat));
    }
    angles.sort((a, b) => a - b);
    let minAngleDiff = Math.PI * 2;
    for (let i = 0; i < angles.length; i++) {
      const diff = (angles[(i + 1) % angles.length] - angles[i] + Math.PI * 2) % (Math.PI * 2);
      minAngleDiff = Math.min(minAngleDiff, diff);
    }
    const idealAngle = (Math.PI * 2) / (nodes.length + 1);
    return Math.max(0.3, 1 - Math.abs(minAngleDiff - idealAngle) / Math.PI);
  }

  private median(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  /**
   * Combine TDOA and RSSI estimates using weighted average
   */
  private combineEstimates(tdoa: BaseEstimate, rssi: BaseEstimate): BaseEstimate {
    // Weight TDOA more heavily (70%) as it's more accurate
    const tdoaWeight = 0.7;
    const rssiWeight = 0.3;

    const combinedLat = tdoa.lat * tdoaWeight + rssi.lat * rssiWeight;
    const combinedLon = tdoa.lon * tdoaWeight + rssi.lon * rssiWeight;
    const combinedConfidence = Math.max(tdoa.confidence, rssi.confidence) * 0.95;

    // Merge contributors
    const contributorMap = new Map<string, (typeof tdoa.contributors)[0]>();

    for (const c of [...tdoa.contributors, ...rssi.contributors]) {
      const existing = contributorMap.get(c.nodeId ?? 'unknown');
      if (existing) {
        existing.weight += c.weight ?? 0;
        if (c.maxRssi !== undefined) {
          existing.maxRssi =
            existing.maxRssi !== undefined ? Math.max(existing.maxRssi, c.maxRssi) : c.maxRssi;
        }
      } else {
        contributorMap.set(c.nodeId ?? 'unknown', { ...c });
      }
    }

    return {
      lat: this.clampLatitude(combinedLat),
      lon: this.clampLongitude(combinedLon),
      confidence: this.clamp01(combinedConfidence),
      totalWeight: tdoa.totalWeight + rssi.totalWeight,
      samples: Math.max(tdoa.samples, rssi.samples),
      uniqueNodes: Math.max(tdoa.uniqueNodes, rssi.uniqueNodes),
      spreadMeters: Math.min(tdoa.spreadMeters, rssi.spreadMeters),
      method: 'hybrid',
      contributors: Array.from(contributorMap.values()).sort((a, b) => b.weight - a.weight),
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
