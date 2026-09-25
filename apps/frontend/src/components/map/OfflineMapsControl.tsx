import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import { useMap } from 'react-leaflet';

import {
  cancelTilePreload,
  clearTileCache,
  getTileStatus,
  startTilePreload,
} from '../../api/tiles';
import { useAuthStore } from '../../stores/auth-store';

interface Props {
  layers: Array<{ key: string; name: string }>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function OfflineMapsControl({ layers }: Props) {
  const map = useMap();
  const role = useAuthStore((state) => state.user?.role);
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState('');
  const [radiusKm, setRadiusKm] = useState(5);
  const [minZoom, setMinZoom] = useState(10);
  const [maxZoom, setMaxZoom] = useState(15);
  const [error, setError] = useState<string | null>(null);

  const canDownload = role === 'ADMIN' || role === 'OPERATOR';

  const status = useQuery({
    queryKey: ['tile-status'],
    queryFn: getTileStatus,
    enabled: open && canDownload,
    refetchInterval: (query) => (query.state.data?.preload.active ? 1000 : 10_000),
  });

  useEffect(() => {
    if (containerRef.current) {
      L.DomEvent.disableClickPropagation(containerRef.current);
      L.DomEvent.disableScrollPropagation(containerRef.current);
    }
  }, [open]);

  const downloadable = layers.filter((layer) =>
    status.data?.providers.some((p) => p.id === layer.key && p.preload),
  );
  const selected = provider || downloadable[0]?.key || '';
  const selectedMaxZoom = Math.min(
    16,
    status.data?.providers.find((p) => p.id === selected)?.maxZoom ?? 16,
  );

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tile-status'] });
  const onError = (err: unknown) => setError(err instanceof Error ? err.message : 'Failed');

  const start = useMutation({
    mutationFn: () => {
      const center = map.getCenter();
      return startTilePreload({
        provider: selected,
        lat: center.lat,
        lng: center.lng,
        radiusKm,
        minZoom,
        maxZoom: Math.min(maxZoom, selectedMaxZoom),
      });
    },
    onMutate: () => setError(null),
    onSuccess: refresh,
    onError,
  });
  const cancel = useMutation({ mutationFn: cancelTilePreload, onSuccess: refresh, onError });
  const clear = useMutation({ mutationFn: clearTileCache, onSuccess: refresh, onError });

  if (!canDownload) {
    return null;
  }

  const preload = status.data?.preload;
  const done = preload ? preload.completed + preload.skipped + preload.failed : 0;

  return (
    <div className="leaflet-bottom leaflet-left">
      <div ref={containerRef} className="leaflet-control offline-maps">
        {!open ? (
          <button type="button" className="offline-maps__toggle" onClick={() => setOpen(true)}>
            Offline maps
          </button>
        ) : (
          <div className="offline-maps__panel">
            <div className="offline-maps__header">
              <strong>Offline maps</strong>
              <button type="button" className="offline-maps__close" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            {status.data && !status.data.online ? (
              <p className="offline-maps__hint">No internet. Showing saved tiles.</p>
            ) : null}
            {downloadable.length === 0 ? (
              <p className="offline-maps__hint">Loading.</p>
            ) : (
              <>
                <label>
                  <span>Map</span>
                  <select value={selected} onChange={(e) => setProvider(e.target.value)}>
                    {downloadable.map((layer) => (
                      <option key={layer.key} value={layer.key}>
                        {layer.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Radius (km)</span>
                  <input
                    type="number"
                    min={0.5}
                    max={50}
                    step={0.5}
                    value={radiusKm}
                    onChange={(e) => setRadiusKm(Number(e.target.value))}
                  />
                </label>
                <label>
                  <span>Zoom</span>
                  <span className="offline-maps__zoom">
                    <input
                      type="number"
                      min={0}
                      max={selectedMaxZoom}
                      value={minZoom}
                      onChange={(e) => setMinZoom(Number(e.target.value))}
                    />
                    to
                    <input
                      type="number"
                      min={minZoom}
                      max={selectedMaxZoom}
                      value={Math.min(maxZoom, selectedMaxZoom)}
                      onChange={(e) => setMaxZoom(Number(e.target.value))}
                    />
                  </span>
                </label>
                {preload?.active ? (
                  <div className="offline-maps__progress">
                    <progress max={preload.total} value={done} />
                    <span>
                      {done} / {preload.total}
                      {preload.failed ? ` · ${preload.failed} failed` : ''}
                    </span>
                    <button type="button" onClick={() => cancel.mutate()}>
                      Stop
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="offline-maps__start"
                    disabled={start.isPending || !selected}
                    onClick={() => start.mutate()}
                  >
                    Save area around map center
                  </button>
                )}
              </>
            )}
            {error ? <p className="offline-maps__error">{error}</p> : null}
            {status.data ? (
              <div className="offline-maps__footer">
                <span>
                  {formatBytes(status.data.cache.bytes)} of{' '}
                  {formatBytes(status.data.cache.maxBytes)}
                </span>
                {role === 'ADMIN' ? (
                  <button
                    type="button"
                    disabled={clear.isPending}
                    onClick={() => {
                      if (window.confirm('Delete all saved map tiles?')) {
                        clear.mutate();
                      }
                    }}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
