export type SerialParseResult =
  | SerialNodeTelemetry
  | SerialTargetDetected
  | SerialAlertEvent
  | SerialDroneTelemetry
  | SerialCommandAck
  | SerialCommandResult
  | SerialRawFrame;

export interface SerialNodeTelemetry {
  kind: 'node-telemetry';
  nodeId: string;
  lat?: number;
  lon?: number;
  timestamp?: Date;
  lastMessage?: string;
  raw: string;
  temperatureC?: number;
  temperatureF?: number;
  temperatureUpdatedAt?: Date;
}

export interface SerialTargetDetected {
  kind: 'target-detected';
  nodeId: string;
  mac: string;
  rssi?: number;
  type?: string;
  name?: string;
  channel?: number;
  lat?: number;
  lon?: number;
  timestamp?: Date;
  detectionTimestamp?: number; // Microseconds since epoch (for TDOA)
  raw: string;
}

export interface SerialAlertEvent {
  kind: 'alert';
  level: 'INFO' | 'NOTICE' | 'ALERT' | 'CRITICAL';
  category: string;
  nodeId?: string;
  message: string;
  data?: Record<string, unknown>;
  raw: string;
}

export interface SerialDroneTelemetry {
  kind: 'drone-telemetry';
  nodeId?: string;
  droneId: string;
  mac?: string;
  lat: number;
  lon: number;
  altitude?: number;
  speed?: number;
  operatorLat?: number;
  operatorLon?: number;
  rssi?: number;
  raw: string;
  timestamp?: Date;
}

export interface SerialCommandAck {
  kind: 'command-ack';
  nodeId: string;
  ackType: string;
  status: string;
  raw: string;
}

export interface SerialCommandResult {
  kind: 'command-result';
  nodeId: string;
  command: string;
  payload: string;
  raw: string;
}

export interface SerialRawFrame {
  kind: 'raw';
  raw: string;
}

export interface SerialProtocolParser {
  parseLine(line: string): SerialParseResult[];
  reset(): void;
}
