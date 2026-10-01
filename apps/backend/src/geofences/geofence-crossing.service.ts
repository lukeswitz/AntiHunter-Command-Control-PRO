import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';

import { GeofenceResponse, GeofencesService } from './geofences.service';

export type GeofenceCrossingKind = 'drone' | 'target';

export interface GeofenceCrossing {
  geofence: GeofenceResponse;
  transition: 'enter' | 'exit';
  message: string;
}

@Injectable()
export class GeofenceCrossingService implements OnModuleInit, OnModuleDestroy {
  private geofences: GeofenceResponse[] = [];
  private readonly states = new Map<string, Map<string, boolean>>();
  private subscription?: Subscription;

  constructor(private readonly geofencesService: GeofencesService) {}

  async onModuleInit(): Promise<void> {
    this.geofences = await this.geofencesService.list({ includeRemote: true }).catch(() => []);
    this.subscription = this.geofencesService.getChangesStream().subscribe((event) => {
      if (event.type === 'delete') {
        this.geofences = this.geofences.filter((geofence) => geofence.id !== event.geofence.id);
        this.states.delete(event.geofence.id);
        return;
      }
      const index = this.geofences.findIndex((geofence) => geofence.id === event.geofence.id);
      if (index >= 0) {
        this.geofences[index] = event.geofence;
      } else {
        this.geofences.push(event.geofence);
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  evaluate(
    kind: GeofenceCrossingKind,
    entityKey: string,
    label: string,
    lat: number | null | undefined,
    lon: number | null | undefined,
  ): GeofenceCrossing[] {
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      return [];
    }
    const crossings: GeofenceCrossing[] = [];
    this.geofences.forEach((geofence) => {
      const applies = kind === 'drone' ? geofence.appliesToDrones : geofence.appliesToTargets;
      if (!geofence.alarm.enabled || geofence.polygon.length < 3 || !applies) {
        return;
      }
      const inside = this.pointInPolygon(lat, lon, geofence.polygon);
      const stateMap = this.states.get(geofence.id) ?? new Map<string, boolean>();
      const prevInside = stateMap.get(entityKey) ?? false;
      stateMap.set(entityKey, inside);
      this.states.set(geofence.id, stateMap);

      if (inside && !prevInside) {
        crossings.push({
          geofence,
          transition: 'enter',
          message: this.formatMessage(geofence.alarm.message, geofence.name, label, kind, 'enter'),
        });
      } else if (!inside && prevInside && geofence.alarm.triggerOnExit) {
        crossings.push({
          geofence,
          transition: 'exit',
          message: this.formatMessage(geofence.alarm.message, geofence.name, label, kind, 'exit'),
        });
      }
    });
    return crossings;
  }

  forget(entityKey: string): void {
    this.states.forEach((stateMap) => stateMap.delete(entityKey));
  }

  private formatMessage(
    template: string | null | undefined,
    geofenceName: string,
    entity: string,
    type: GeofenceCrossingKind,
    event: 'enter' | 'exit',
  ): string {
    const base =
      template && template.trim().length > 0 ? template : '{entity} {event}s geofence {geofence}';
    return base
      .replace(/\{geofence\}/gi, geofenceName)
      .replace(/\{entity\}/gi, entity)
      .replace(/\{node\}/gi, entity)
      .replace(/\{type\}/gi, type)
      .replace(/\{event\}/gi, event);
  }

  private pointInPolygon(lat: number, lon: number, polygon: GeofenceResponse['polygon']): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lat;
      const yi = polygon[i].lon;
      const xj = polygon[j].lat;
      const yj = polygon[j].lon;
      const intersect =
        yi > lon !== yj > lon && lat < ((xj - xi) * (lon - yi)) / (yj - yi + Number.EPSILON) + xi;
      if (intersect) {
        inside = !inside;
      }
    }
    return inside;
  }
}
