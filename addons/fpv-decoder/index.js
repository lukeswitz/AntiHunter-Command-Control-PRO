'use strict';

class StubFpvDecoder {
  constructor(options = {}) {
    this.options = options;
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
}

function createFpvDecoder(options) {
  return new StubFpvDecoder(options);
}

module.exports = {
  createFpvDecoder,
  StubFpvDecoder,
};
