import { SerialState } from './serial.interfaces';
import { SerialParseResult } from './serial.types';

export type SerialClusterRole = 'leader' | 'replica' | 'standalone';

export type SerialRpcAction = 'connect' | 'disconnect' | 'listPorts' | 'simulate' | 'getState';

export type SerializedSerialParseResult = Omit<
  SerialParseResult,
  'timestamp' | 'temperatureUpdatedAt'
> & {
  timestamp?: string;
  temperatureUpdatedAt?: string;
};

export interface SerialClusterEventMessage {
  channel: 'serial';
  type: 'event';
  events: SerializedSerialParseResult[];
}

export interface SerialClusterStateMessage {
  channel: 'serial';
  type: 'state';
  state: SerialState;
}

export interface SerialClusterRpcRequestMessage {
  channel: 'serial';
  type: 'rpc-request';
  requestId: string;
  action: SerialRpcAction;
  payload?: unknown;
  sourceId?: number;
}

export interface SerialClusterRpcResponseMessage {
  channel: 'serial';
  type: 'rpc-response';
  requestId: string;
  success: boolean;
  payload?: unknown;
  error?: string;
  targetId?: number;
}

export type SerialClusterMessage =
  | SerialClusterEventMessage
  | SerialClusterStateMessage
  | SerialClusterRpcRequestMessage
  | SerialClusterRpcResponseMessage;

export function serializeSerialParseResult(event: SerialParseResult): SerializedSerialParseResult {
  const payload = { ...event } as SerializedSerialParseResult;
  const timestamp = (event as { timestamp?: Date }).timestamp;
  if (timestamp instanceof Date) {
    payload.timestamp = timestamp.toISOString();
  }
  const temperatureUpdatedAt = (event as { temperatureUpdatedAt?: Date }).temperatureUpdatedAt;
  if (temperatureUpdatedAt instanceof Date) {
    payload.temperatureUpdatedAt = temperatureUpdatedAt.toISOString();
  }
  return payload;
}

export function deserializeSerialParseResult(
  payload: SerializedSerialParseResult,
): SerialParseResult {
  const clone = { ...payload } as SerialParseResult & {
    timestamp?: string | Date;
    temperatureUpdatedAt?: string | Date;
  };
  if ('timestamp' in clone && typeof clone.timestamp === 'string') {
    clone.timestamp = new Date(clone.timestamp);
  }
  if ('temperatureUpdatedAt' in clone && typeof clone.temperatureUpdatedAt === 'string') {
    clone.temperatureUpdatedAt = new Date(clone.temperatureUpdatedAt);
  }
  return clone;
}
