import { ProtocolKey } from './protocol-registry';

export interface SerialConnectionOptions {
  path?: string;
  baudRate: number;
  delimiter: string;
  protocol: ProtocolKey;
  rawDelimiter?: string;
  autoDetectDelimiter?: boolean;
  writeDelimiters: string[];
  sendMode?: string;
  hopLimit?: number;
  sendChannel?: number;
}

export interface SerialState {
  connected: boolean;
  path?: string;
  baudRate?: number;
  lastError?: string;
  protocol?: ProtocolKey;
}
