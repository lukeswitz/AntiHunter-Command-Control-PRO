export interface StatusFrameInput {
  name: string;
  hits: number;
  tempC?: number;
  uptimeSec: number;
  lat?: number;
  lon?: number;
  batteryLevel?: number;
}

export function formatUptime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export function buildStatusFrame(input: StatusFrameInput): string {
  const temp = Number.isFinite(input.tempC) ? (input.tempC as number).toFixed(1) : '?';
  let frame = `${input.name}: STATUS: Mode:C2 Scan:IDLE Hits:${Math.max(0, Math.floor(input.hits))} Temp:${temp}C Up:${formatUptime(input.uptimeSec)}`;
  if (Number.isFinite(input.lat) && Number.isFinite(input.lon)) {
    frame += ` GPS:${(input.lat as number).toFixed(6)},${(input.lon as number).toFixed(6)}`;
  }
  if (input.batteryLevel && input.batteryLevel > 0) {
    frame += ` Batt:${Math.min(100, Math.round(input.batteryLevel))}%`;
  }
  return frame;
}

const STATUS_REQUEST = /^\s*@(ALL|[A-Za-z0-9_-]{2,12})\s+STATUS\s*$/i;

export function isStatusRequestFor(text: string, shortName: string | undefined): boolean {
  const match = STATUS_REQUEST.exec(text);
  if (!match) {
    return false;
  }
  const target = match[1].toUpperCase();
  return target === 'ALL' || (!!shortName && target === shortName.toUpperCase());
}
