'use strict';

class StubFpvDecoder {
  constructor(options = {}) {
    this.config = this.normalizeOptions(options);
    this.running = false;
    this.frameListeners = new Set();
    this.interval = undefined;
    this.frameIndex = 0;
  }

  async start() {
    this.running = true;
    this.interval = setInterval(() => {
      this.emitFrame(this.buildSvgFrame());
    }, 1000);

    return {
      stop: () => this.stop(),
    };
  }

  onFrame(listener) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  emitFrame(frame) {
    if (!this.running) {
      return;
    }
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // ignore listener errors in stub
      }
    }
  }

  async stop() {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.frameListeners.clear();
  }

  updateConfig(options = {}) {
    this.config = this.normalizeOptions({ ...this.config, ...options });
  }

  buildSvgFrame() {
    const width = 360;
    const height = 240;
    const timestamp = Date.now();
    const colors = ['#ff0044', '#ffaa00', '#00cc66', '#0099ff', '#6633ff', '#ff00aa'];
    const color = colors[this.frameIndex % colors.length];
    this.frameIndex += 1;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <defs>
        <linearGradient id="grad${this.frameIndex % 10}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:${color};stop-opacity:1" />
          <stop offset="100%" style="stop-color:#111111;stop-opacity:1" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#grad${this.frameIndex % 10})" />
      <text x="50%" y="50%" font-size="28" fill="#ffffff" text-anchor="middle" font-family="Arial, sans-serif">
        FPV Stub Frame ${this.frameIndex}
      </text>
      <text x="50%" y="66%" font-size="16" fill="#ffffff" text-anchor="middle" font-family="Arial, sans-serif">
        ${new Date(timestamp).toISOString()}
      </text>
      <text x="50%" y="82%" font-size="14" fill="#ffffff" text-anchor="middle" font-family="Arial, sans-serif">
        ${this.describeConfig()}
      </text>
    </svg>`;

    return {
      width,
      height,
      format: 'svg',
      mimeType: 'image/svg+xml',
      data: Buffer.from(svg, 'utf8'),
      timestamp,
    };
  }

  describeConfig() {
    const parts = [];
    if (typeof this.config.frequencyMHz === 'number') {
      parts.push(`${this.config.frequencyMHz.toFixed(1)} MHz`);
    }
    if (typeof this.config.bandwidthMHz === 'number') {
      parts.push(`${this.config.bandwidthMHz.toFixed(1)} MHz BW`);
    }
    if (typeof this.config.gainDb === 'number') {
      parts.push(`${this.config.gainDb.toFixed(1)} dB`);
    }
    const sourceLabel = this.config.source ?? 'default';
    parts.push(`src:${sourceLabel}`);
    return parts.join(' / ');
  }

  normalizeOptions(options) {
    return {
      source: options.source ?? 'soapy-litexm2sdr',
      channel: typeof options.channel === 'number' ? options.channel : 0,
      frequencyMHz:
        typeof options.frequencyMHz === 'number' && Number.isFinite(options.frequencyMHz)
          ? options.frequencyMHz
          : null,
      bandwidthMHz:
        typeof options.bandwidthMHz === 'number' && Number.isFinite(options.bandwidthMHz)
          ? options.bandwidthMHz
          : null,
      gainDb:
        typeof options.gainDb === 'number' && Number.isFinite(options.gainDb)
          ? options.gainDb
          : null,
    };
  }
}

function createFpvDecoder(options) {
  return new StubFpvDecoder(options);
}

module.exports = {
  createFpvDecoder,
  StubFpvDecoder,
};
