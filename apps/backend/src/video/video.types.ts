export interface FpvAddonStatus {
  enabled: boolean;
  available: boolean;
  message?: string;
  framesReceived: number;
  lastFrameAt?: string;
}

export interface FpvFramePayload {
  width: number;
  height: number;
  format: string;
  mimeType?: string;
  data: string; // base64 encoded payload
  timestamp: string;
}
