import type { CSSProperties } from 'react';
import { MdVisibility } from 'react-icons/md';

import type { DeviceClassification, DeviceFamily } from '../api/types';

export const FAMILY_HUE: Record<DeviceFamily, number> = {
  Phone: 185,
  Tag: 45,
  Audio: 305,
  Wearable: 265,
  Vehicle: 0,
  Drone: 330,
  Camera: 25,
  Radio: 12,
  Glasses: 285,
  Health: -1,
  Lock: 60,
  Home: -1,
  Computer: -1,
  Input: -1,
  Beacon: -1,
  Router: -1,
  'Public Safety': 220,
  'Hacking Tool': 120,
};

export type ClassFilter = 'all' | 'watch' | 'none' | DeviceFamily;

const SOURCE_LABEL: Record<string, string> = {
  advert: 'Advert',
  name: 'Name',
  signature: 'Signature',
  vendor: 'Vendor',
  address: 'Address',
};

export function hueStyle(family: DeviceFamily | null): CSSProperties {
  const hue = family ? FAMILY_HUE[family] : -1;
  return { '--h': Math.max(hue, 0), '--s': hue >= 0 ? 1 : 0 } as CSSProperties;
}

export function classTitle(c: DeviceClassification): string {
  const lines = c.evidence.map(
    (e) => `${SOURCE_LABEL[e.source] ?? e.source}: ${e.value}${e.family ? ` → ${e.family}` : ''}`,
  );
  if (c.confidence) {
    lines.push(`Confidence: ${c.confidence}`);
  }
  return lines.join('\n');
}

export function matchesClassFilter(
  c: DeviceClassification | null | undefined,
  filter: ClassFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'watch') return Boolean(c?.watch);
  if (filter === 'none') return !c?.family;
  return c?.family === filter;
}

export function compareClassifications(
  a: DeviceClassification | null | undefined,
  b: DeviceClassification | null | undefined,
): number {
  const fa = a?.family ?? '￿';
  const fb = b?.family ?? '￿';
  return fa.localeCompare(fb) || (a?.label ?? '').localeCompare(b?.label ?? '');
}

export function DeviceClassBadge({
  classification,
}: {
  classification: DeviceClassification | null | undefined;
}) {
  if (!classification || (!classification.family && !classification.label)) {
    return <span className="dclass dclass--empty">—</span>;
  }
  const { family, label, confidence, watch } = classification;
  const detail = label && label !== family ? label : null;
  return (
    <span
      className={`dclass dclass--${confidence ?? 'none'}${watch ? ' dclass--watch' : ''}`}
      style={hueStyle(family)}
      title={classTitle(classification)}
    >
      <span className="dclass__dot" aria-hidden="true" />
      <span className="dclass__family">{family ?? 'Unclassified'}</span>
      {detail ? <span className="dclass__label">{detail}</span> : null}
    </span>
  );
}

interface ClassFilterBarProps {
  items: Array<DeviceClassification | null | undefined>;
  value: ClassFilter;
  onChange: (value: ClassFilter) => void;
}

export function ClassFilterBar({ items, value, onChange }: ClassFilterBarProps) {
  const counts = new Map<DeviceFamily, number>();
  let watch = 0;
  let none = 0;
  for (const c of items) {
    if (c?.watch) watch += 1;
    if (c?.family) {
      counts.set(c.family, (counts.get(c.family) ?? 0) + 1);
    } else {
      none += 1;
    }
  }
  const families = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const total = items.length;
  if (total === 0) {
    return null;
  }
  const toggle = (next: ClassFilter) => onChange(value === next ? 'all' : next);

  return (
    <div className="dclass-filter">
      <div className="dclass-strip" role="img" aria-label="Device class distribution">
        {families.map(([family, count]) => (
          <span
            key={family}
            className={`dclass-strip__seg${value !== 'all' && value !== family ? ' is-dim' : ''}`}
            style={{ ...hueStyle(family), flexGrow: count }}
            title={`${family}: ${count}`}
          />
        ))}
        {none > 0 ? (
          <span
            className={`dclass-strip__seg dclass-strip__seg--none${value !== 'all' && value !== 'none' ? ' is-dim' : ''}`}
            style={{ flexGrow: none }}
            title={`Unclassified: ${none}`}
          />
        ) : null}
      </div>
      <div className="dclass-chips" role="toolbar" aria-label="Filter by device class">
        <button
          type="button"
          className={`dclass-chip${value === 'all' ? ' is-active' : ''}`}
          aria-pressed={value === 'all'}
          onClick={() => onChange('all')}
        >
          All <span className="dclass-chip__count">{total}</span>
        </button>
        {watch > 0 ? (
          <button
            type="button"
            className={`dclass-chip dclass-chip--watch${value === 'watch' ? ' is-active' : ''}`}
            aria-pressed={value === 'watch'}
            onClick={() => toggle('watch')}
            title="Trackers, cameras, radios, drones, public safety, hacking tools"
          >
            <MdVisibility aria-hidden="true" />
            Watch <span className="dclass-chip__count">{watch}</span>
          </button>
        ) : null}
        {families.map(([family, count]) => (
          <button
            key={family}
            type="button"
            className={`dclass-chip${value === family ? ' is-active' : ''}`}
            style={hueStyle(family)}
            aria-pressed={value === family}
            onClick={() => toggle(family)}
          >
            <span className="dclass__dot" aria-hidden="true" />
            {family} <span className="dclass-chip__count">{count}</span>
          </button>
        ))}
        {none > 0 ? (
          <button
            type="button"
            className={`dclass-chip${value === 'none' ? ' is-active' : ''}`}
            style={hueStyle(null)}
            aria-pressed={value === 'none'}
            onClick={() => toggle('none')}
          >
            Unclassified <span className="dclass-chip__count">{none}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
