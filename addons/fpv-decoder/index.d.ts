export type FpvFrameFormat = 'svg' | 'gray8';

export interface FpvFrame {
  width: number;
  height: number;
  /**
   * Payload format. `svg` indicates inline SVG markup (UTF-8 buffer).
   * `gray8` would represent raw luminance bytes (future implementation).
   */
  format: FpvFrameFormat;
  /**
   * Optional MIME type hint for the consumer (e.g., image/svg+xml).
   */
  mimeType?: string;
  /**
   * Raw frame data buffer.
   */
  data: Buffer;
  /**
   * Timestamp in milliseconds since epoch.
   */
  timestamp: number;
}

export interface FpvDecoderOptions {
  source?: string;
  channel?: number;
  frequencyMHz?: number | null;
  bandwidthMHz?: number | null;
  gainDb?: number | null;
}

export interface FpvDecoder {
  start(): Promise<{ stop(): Promise<void> | void }>;
  stop(): Promise<void> | void;
  onFrame(listener: (frame: FpvFrame) => void): () => void;
  updateConfig(options: FpvDecoderOptions): void;
}

export function createFpvDecoder(options?: FpvDecoderOptions): FpvDecoder;

