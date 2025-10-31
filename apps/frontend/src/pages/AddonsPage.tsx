import { useQuery } from '@tanstack/react-query';

import { apiClient } from '../api/client';
import type { FpvStatus } from '../api/types';

export function AddonsPage() {
  const fpvStatusQuery = useQuery({
    queryKey: ['fpvStatus'],
    queryFn: () => apiClient.get<FpvStatus>('/video/fpv/status'),
    staleTime: 10_000,
  });

  const fpvStatus = fpvStatusQuery.data;

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Add-ons</h1>
          <p className="panel__subtitle">
            Optional modules that extend the Command Center. Enable or install add-ons as needed for
            your deployment.
          </p>
        </div>
      </header>

      <div className="config-grid">
        <section className="config-card">
          <header>
            <h2>FPV Decoder (Experimental)</h2>
            <p>Stream NTSC FPV video by installing the optional SDR decoder addon.</p>
          </header>
          <div className="config-card__body">
            {fpvStatusQuery.isLoading ? (
              <div>Checking addon status…</div>
            ) : fpvStatusQuery.isError ? (
              <div className="form-error">
                Unable to retrieve addon status. Verify the backend is reachable.
              </div>
            ) : fpvStatus ? (
              <>
                <div className="config-row">
                  <span className="config-label">Enabled</span>
                  <span className="config-value">{fpvStatus.enabled ? 'Yes' : 'No'}</span>
                </div>
                <div className="config-row">
                  <span className="config-label">Addon Loaded</span>
                  <span className="config-value">
                    {fpvStatus.available ? 'Ready' : 'Not available'}
                  </span>
                </div>
                <div className="config-row">
                  <span className="config-label">Frames Received</span>
                  <span className="config-value">{fpvStatus.framesReceived}</span>
                </div>
                <div className="config-row">
                  <span className="config-label">Last Frame</span>
                  <span className="config-value">
                    {fpvStatus.lastFrameAt ? new Date(fpvStatus.lastFrameAt).toLocaleString() : '—'}
                  </span>
                </div>
                {fpvStatus.message ? (
                  <div
                    className={
                      fpvStatus.available
                        ? 'form-hint'
                        : fpvStatus.enabled
                          ? 'form-error'
                          : 'form-hint'
                    }
                  >
                    {fpvStatus.message}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="form-hint">Addon status unavailable.</div>
            )}
          </div>
          <footer className="config-card__body">
            <div className="config-hint">
              Install with <code>pnpm install --filter @command-center/fpv-decoder</code> (or define
              a helper script) and set <code>FPV_DECODER_ENABLED=true</code>. The shipped addon is a
              scaffold—replace its implementation in <code>addons/fpv-decoder</code> with your
              SDR/NTSC pipeline to begin streaming video frames.
            </div>
          </footer>
        </section>
      </div>
    </section>
  );
}
