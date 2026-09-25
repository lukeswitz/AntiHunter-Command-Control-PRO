import { Transform, TransformCallback } from 'node:stream';

const MAGIC_BYTE_1 = 0x94;
const MAGIC_BYTE_2 = 0xc3;
const MAX_PAYLOAD_SIZE = 512;

export type MeshtasticFrameEvent = { type: 'frame'; data: Buffer } | { type: 'text'; data: string };

enum State {
  WaitStart1,
  WaitStart2,
  WaitLenHi,
  WaitLenLo,
  ReadPayload,
}

export class MeshtasticFrameParser extends Transform {
  private state = State.WaitStart1;
  private payloadLen = 0;
  private payload: number[] = [];
  private textAccumulator = '';

  constructor() {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    for (const byte of chunk) {
      this.consume(byte);
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.flushText();
    callback();
  }

  private consume(byte: number): void {
    switch (this.state) {
      case State.WaitStart1:
        if (byte === MAGIC_BYTE_1) {
          this.state = State.WaitStart2;
        } else {
          this.accumulateText(byte);
        }
        break;

      case State.WaitStart2:
        if (byte === MAGIC_BYTE_2) {
          this.flushText();
          this.state = State.WaitLenHi;
        } else {
          this.accumulateText(MAGIC_BYTE_1);
          this.state = State.WaitStart1;
          this.consume(byte);
        }
        break;

      case State.WaitLenHi:
        this.payloadLen = byte << 8;
        this.state = State.WaitLenLo;
        break;

      case State.WaitLenLo:
        this.payloadLen |= byte;
        if (this.payloadLen === 0 || this.payloadLen > MAX_PAYLOAD_SIZE) {
          this.state = State.WaitStart1;
        } else {
          this.payload = [];
          this.state = State.ReadPayload;
        }
        break;

      case State.ReadPayload:
        this.payload.push(byte);
        if (this.payload.length >= this.payloadLen) {
          this.push({
            type: 'frame',
            data: Buffer.from(this.payload),
          } satisfies MeshtasticFrameEvent);
          this.payload = [];
          this.state = State.WaitStart1;
        }
        break;
    }
  }

  private accumulateText(byte: number): void {
    if (byte === 0x0a || byte === 0x0d) {
      this.flushText();
      return;
    }
    if (this.textAccumulator.length < 4096) {
      this.textAccumulator += String.fromCharCode(byte);
    }
  }

  private flushText(): void {
    const line = this.textAccumulator.replace(/[^\x20-\x7e]/g, '').trim();
    this.textAccumulator = '';
    if (line) {
      this.push({ type: 'text', data: line } satisfies MeshtasticFrameEvent);
    }
  }
}
