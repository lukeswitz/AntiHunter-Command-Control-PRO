import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { apiClient } from '../api/client';
import { SiteSummary } from '../api/types';
import { forceLogout, getAuthToken } from '../auth/session';

type ExportFormat = 'csv' | 'json' | 'geojson';
type ExportType = 'inventory' | 'command-logs' | 'targets' | 'trails';
type ExportStatus = 'idle' | 'loading' | 'success' | 'error';

interface ExportDefinition {
  key: ExportType;
  title: string;
  description: string;
  defaultFormat: ExportFormat;
  formats: ExportFormat[];
  supportsDateRange: boolean;
  supportsSite: boolean;
}

interface ExportCardState {
  format: ExportFormat;
  from: string;
  to: string;
  siteId: string;
  status: ExportStatus;
  message: string | null;
}

const EXPORT_DEFINITIONS: ExportDefinition[] = [
  {
    key: 'inventory',
    title: 'Inventory Devices',
    description:
      'Full device inventory with vendor, RSSI statistics, and last-seen metadata. Ideal for offline analysis.',
    defaultFormat: 'csv',
    formats: ['csv', 'json'],
    supportsDateRange: false,
    supportsSite: true,
  },
  {
    key: 'command-logs',
    title: 'Command Log',
    description:
      'Historical record of commands, ACKs, and outcomes. Filter by time window to scope investigations.',
    defaultFormat: 'csv',
    formats: ['csv', 'json'],
    supportsDateRange: true,
    supportsSite: false,
  },
  {
    key: 'targets',
    title: 'Targets',
    description:
      'All tracked targets with location and status. GeoJSON exports drop straight into GIS tools.',
    defaultFormat: 'geojson',
    formats: ['geojson', 'json', 'csv'],
    supportsDateRange: true,
    supportsSite: true,
  },
  {
    key: 'trails',
    title: 'Node Trails',
    description:
      'Node trail lines built from position history. Useful for coverage reviews and incident reconstructions.',
    defaultFormat: 'geojson',
    formats: ['geojson', 'json'],
    supportsDateRange: true,
    supportsSite: true,
  },
];

const DEFAULT_SITE_OPTION = 'all';

export function ExportsPage() {
  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
  });

  const initialState = useMemo(() => {
    const state: Record<ExportType, ExportCardState> = {} as Record<ExportType, ExportCardState>;
    EXPORT_DEFINITIONS.forEach((definition) => {
      state[definition.key] = {
        format: definition.defaultFormat,
        from: '',
        to: '',
        siteId: DEFAULT_SITE_OPTION,
        status: 'idle',
        message: null,
      };
    });
    return state;
  }, []);

  const [cardState, setCardState] = useState<Record<ExportType, ExportCardState>>(initialState);

  const handleFieldChange = (
    key: ExportType,
    patch: Partial<Pick<ExportCardState, 'format' | 'from' | 'to' | 'siteId'>>,
  ) => {
    setCardState((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        ...patch,
        status: patch.format || patch.from || patch.to || patch.siteId ? 'idle' : prev[key].status,
        message: patch.format || patch.from || patch.to || patch.siteId ? null : prev[key].message,
      },
    }));
  };

  const handleDownload = async (definition: ExportDefinition) => {
    const state = cardState[definition.key];

    if (definition.supportsDateRange && state.from && state.to) {
      const fromDate = new Date(state.from);
      const toDate = new Date(state.to);
      if (fromDate > toDate) {
        setCardState((prev) => ({
          ...prev,
          [definition.key]: {
            ...prev[definition.key],
            status: 'error',
            message: '`From` must be earlier than `To`.',
          },
        }));
        return;
      }
    }

    setCardState((prev) => ({
      ...prev,
      [definition.key]: { ...prev[definition.key], status: 'loading', message: null },
    }));

    const params = new URLSearchParams();
    params.set('format', state.format);

    if (definition.supportsSite && state.siteId && state.siteId !== DEFAULT_SITE_OPTION) {
      params.set('siteId', state.siteId);
    }
    if (definition.supportsDateRange) {
      if (state.from) {
        const iso = toIsoString(state.from);
        if (iso) {
          params.set('from', iso);
        }
      }
      if (state.to) {
        const iso = toIsoString(state.to);
        if (iso) {
          params.set('to', iso);
        }
      }
    }

    const token = getAuthToken();
    try {
      const response = await fetch(`/api/exports/${definition.key}?${params.toString()}`, {
        method: 'GET',
        headers: {
          ...(token
            ? {
                Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
              }
            : {}),
        },
      });

      if (response.status === 401) {
        forceLogout();
        throw new Error('Unauthorized');
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Failed to generate export.');
      }

      const blob = await response.blob();
      const fallbackName = buildFilename(definition.key, state.format);
      const disposition = response.headers.get('content-disposition');
      const filename = parseFilename(disposition, fallbackName);

      triggerBrowserDownload(blob, filename);

      setCardState((prev) => ({
        ...prev,
        [definition.key]: {
          ...prev[definition.key],
          status: 'success',
          message: `Download started (${filename}).`,
        },
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to generate export. Please retry.';
      setCardState((prev) => ({
        ...prev,
        [definition.key]: {
          ...prev[definition.key],
          status: 'error',
          message,
        },
      }));
    }
  };

  const sites = sitesQuery.data ?? [];
  const hasSites = sites.length > 0;

  return (
    <section className="panel exports-panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Exports</h1>
          <p className="panel__subtitle">
            Download curated datasets for offline analytics, incident reporting, or GIS overlays.
          </p>
        </div>
      </header>

      <div className="exports-grid">
        {EXPORT_DEFINITIONS.map((definition) => {
          const state = cardState[definition.key];
          const loading = state.status === 'loading';

          return (
            <article key={definition.key} className="export-card">
              <header className="export-card__header">
                <div>
                  <h2>{definition.title}</h2>
                  <p>{definition.description}</p>
                </div>
              </header>

              <div className="export-card__body">
                <label className="form-control">
                  <span>Format</span>
                  <select
                    className="control-input"
                    value={state.format}
                    onChange={(event) =>
                      handleFieldChange(definition.key, {
                        format: event.target.value as ExportFormat,
                      })
                    }
                  >
                    {definition.formats.map((format) => (
                      <option key={format} value={format}>
                        {format.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>

                {definition.supportsSite ? (
                  <label className="form-control">
                    <span>Site</span>
                    <select
                      className="control-input"
                      value={state.siteId}
                      onChange={(event) =>
                        handleFieldChange(definition.key, { siteId: event.target.value })
                      }
                      disabled={!hasSites}
                    >
                      <option value={DEFAULT_SITE_OPTION}>All sites</option>
                      {sites.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                    </select>
                    {sitesQuery.isLoading ? (
                      <small className="field-hint">Loading sites…</small>
                    ) : null}
                  </label>
                ) : null}

                {definition.supportsDateRange ? (
                  <div className="export-daterange">
                    <label className="form-control">
                      <span>From</span>
                      <input
                        type="datetime-local"
                        className="control-input"
                        value={state.from}
                        onChange={(event) =>
                          handleFieldChange(definition.key, { from: event.target.value })
                        }
                      />
                    </label>
                    <label className="form-control">
                      <span>To</span>
                      <input
                        type="datetime-local"
                        className="control-input"
                        value={state.to}
                        onChange={(event) =>
                          handleFieldChange(definition.key, { to: event.target.value })
                        }
                      />
                    </label>
                  </div>
                ) : null}
              </div>

              <footer className="export-card__footer">
                <button
                  type="button"
                  className="submit-button"
                  onClick={() => handleDownload(definition)}
                  disabled={loading}
                >
                  {loading ? 'Preparing…' : 'Download'}
                </button>
                {state.message ? (
                  <span
                    className={`export-status export-status--${state.status}`}
                    role={state.status === 'error' ? 'alert' : 'status'}
                  >
                    {state.message}
                  </span>
                ) : null}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function toIsoString(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function buildFilename(type: ExportType, format: ExportFormat): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = format === 'geojson' ? 'geojson' : format;
  return `${type}-${timestamp}.${extension}`;
}

function parseFilename(disposition: string | null, fallback: string): string {
  if (!disposition) {
    return fallback;
  }
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match && match[1]) {
    return decodeURIComponent(match[1]);
  }
  return fallback;
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
