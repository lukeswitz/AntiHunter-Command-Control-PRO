import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';

import { apiClient } from '../api/client';
import type { FpvConfig, FpvFrame, FpvStatus } from '../api/types';

export function AddonsPage() {
  const queryClient = useQueryClient();

  const fpvStatusQuery = useQuery({
    queryKey: ['fpvStatus'],
    queryFn: () => apiClient.get<FpvStatus>('/video/fpv/status'),
    staleTime: 10_000,
  });

  const fpvStatus = fpvStatusQuery.data;

  const fpvConfigQuery = useQuery({
    queryKey: ['fpvConfig'],
    queryFn: () => apiClient.get<FpvConfig>('/video/fpv/config'),
    enabled: fpvStatus?.enabled ?? false,
    staleTime: 10_000,
  });

  const fpvFrameQuery = useQuery({
    queryKey: ['fpvFrame'],
    queryFn: () => apiClient.get<FpvFrame>('/video/fpv/frame'),
    enabled: Boolean(fpvStatus?.available),
    refetchInterval: fpvStatus?.available ? 2000 : false,
    retry: false,
  });

  const [configForm, setConfigForm] = useState({
    frequencyMHz: '',
    bandwidthMHz: '',
    gainDb: '',
  });
  const [configNotice, setConfigNotice] = useState<string | null>(null);

  useEffect(() => {
    const source = fpvConfigQuery.data ?? fpvStatus?.config;
    if (!source) {
      return;
    }
    setConfigForm({
      frequencyMHz: toInputValue(source.frequencyMHz),
      bandwidthMHz: toInputValue(source.bandwidthMHz),
      gainDb: toInputValue(source.gainDb),
    });
  }, [fpvConfigQuery.data, fpvStatus?.config]);

  const updateFpvConfigMutation = useMutation({
    mutationFn: (payload: Partial<FpvConfig>) =>
      apiClient.put<FpvConfig>('/video/fpv/config', payload),
    onSuccess: (data) => {
      setConfigNotice('Configuration saved.');
      setConfigForm({
        frequencyMHz: toInputValue(data.frequencyMHz),
        bandwidthMHz: toInputValue(data.bandwidthMHz),
        gainDb: toInputValue(data.gainDb),
      });
      queryClient.invalidateQueries({ queryKey: ['fpvStatus'] });
      queryClient.invalidateQueries({ queryKey: ['fpvConfig'] });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Unable to update configuration.';
      setConfigNotice(message);
    },
  });

  const configSummary = useMemo(() => {
    const config = fpvStatus?.config;
    if (!config) {
      return 'N/A';
    }
    const parts: string[] = [];
    if (typeof config.frequencyMHz === 'number') {
      parts.push(`${config.frequencyMHz.toFixed(1)} MHz`);
    }
    if (typeof config.bandwidthMHz === 'number') {
      parts.push(`${config.bandwidthMHz.toFixed(1)} MHz BW`);
    }
    if (typeof config.gainDb === 'number') {
      parts.push(`${config.gainDb.toFixed(1)} dB`);
    }
    return parts.length > 0 ? parts.join(' / ') : 'Defaults';
  }, [fpvStatus?.config]);

  const handleConfigChange =
    (field: 'frequencyMHz' | 'bandwidthMHz' | 'gainDb') =>
    (event: ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      setConfigForm((prev) => ({ ...prev, [field]: value }));
    };

  const handleConfigSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setConfigNotice(null);
    updateFpvConfigMutation.mutate({
      frequencyMHz: parseInputValue(configForm.frequencyMHz),
      bandwidthMHz: parseInputValue(configForm.bandwidthMHz),
      gainDb: parseInputValue(configForm.gainDb),
    });
  };

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">AddOn</h1>
          <p className="panel__subtitle">
            Optional modules that extend the Command Center. Enable or install addons as needed for
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
              <div>Checking addon status...</div>
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
                    {fpvStatus.lastFrameAt
                      ? new Date(fpvStatus.lastFrameAt).toLocaleString()
                      : '--'}
                  </span>
                </div>
                <div className="config-row">
                  <span className="config-label">Current Config</span>
                  <span className="config-value">{configSummary}</span>
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

                {fpvStatus.available ? (
                  <div className="fpv-preview">
                    {fpvFrameQuery.isLoading ? (
                      <div>Loading preview...</div>
                    ) : fpvFrameQuery.isError ? (
                      <div className="form-hint">Waiting for the first frame...</div>
                    ) : fpvFrameQuery.data ? (
                      <img
                        src={`data:${fpvFrameQuery.data.mimeType ?? 'image/svg+xml'};base64,${
                          fpvFrameQuery.data.data
                        }`}
                        alt="FPV preview"
                        width={fpvFrameQuery.data.width}
                        height={fpvFrameQuery.data.height}
                        style={{ maxWidth: '100%', borderRadius: 4, border: '1px solid #1f2937' }}
                      />
                    ) : null}
                  </div>
                ) : null}

                <div className="config-divider" />
                <h3>Decoder Settings</h3>
                <form className="config-stack" onSubmit={handleConfigSubmit}>
                  <div className="config-row">
                    <span className="config-label">Frequency (MHz)</span>
                    <input
                      type="number"
                      step="0.1"
                      value={configForm.frequencyMHz}
                      onChange={handleConfigChange('frequencyMHz')}
                      disabled={!fpvStatus.enabled || updateFpvConfigMutation.isPending}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Bandwidth (MHz)</span>
                    <input
                      type="number"
                      step="0.1"
                      value={configForm.bandwidthMHz}
                      onChange={handleConfigChange('bandwidthMHz')}
                      disabled={!fpvStatus.enabled || updateFpvConfigMutation.isPending}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Gain (dB)</span>
                    <input
                      type="number"
                      step="0.5"
                      value={configForm.gainDb}
                      onChange={handleConfigChange('gainDb')}
                      disabled={!fpvStatus.enabled || updateFpvConfigMutation.isPending}
                    />
                  </div>
                  <div className="controls-row">
                    <button
                      type="submit"
                      className="control-chip"
                      disabled={!fpvStatus.enabled || updateFpvConfigMutation.isPending}
                    >
                      {updateFpvConfigMutation.isPending ? 'Saving...' : 'Save Configuration'}
                    </button>
                  </div>
                  {configNotice ? (
                    <div className="form-hint" role="status">
                      {configNotice}
                    </div>
                  ) : null}
                </form>
              </>
            ) : (
              <div className="form-hint">Addon status unavailable.</div>
            )}
          </div>
          <footer className="config-card__body">
            <div className="config-hint">
              Install with <code>pnpm install --filter @command-center/fpv-decoder</code> (or define
              a helper script) and set <code>FPV_DECODER_ENABLED=true</code>. The shipped addon is a
              scaffold - replace its implementation in <code>addons/fpv-decoder</code> with your
              SDR/NTSC pipeline to begin streaming video frames.
            </div>
          </footer>
        </section>
      </div>
    </section>
  );
}

function toInputValue(value: number | null | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  return '';
}

function parseInputValue(value: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
