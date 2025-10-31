import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangeEvent, useEffect, useMemo, useState } from 'react';

import { apiClient } from '../api/client';
import type {
  AlarmConfig,
  AlarmLevel,
  AppSettings,
  SerialConfig,
  SerialState,
  SiteSummary,
  MqttSiteConfig,
} from '../api/types';
import { DEFAULT_ALERT_COLORS, extractAlertColors } from '../constants/alert-colors';
import { useAlarm } from '../providers/alarm-provider';
import { useNodeStore } from '../stores/node-store';

type AppSettingsUpdate = Partial<AppSettings> & { mailPassword?: string };

const LEVEL_METADATA: Record<AlarmLevel, { label: string; description: string }> = {
  INFO: { label: 'Info', description: 'Low priority notifications (status updates).' },
  NOTICE: { label: 'Notice', description: 'Important events, like new targets.' },
  ALERT: { label: 'Alert', description: 'Actionable events requiring attention.' },
  CRITICAL: { label: 'Critical', description: 'Safety or erase events that must be acknowledged.' },
};

const GAPS: Array<{ key: keyof AlarmConfig; label: string }> = [
  { key: 'gapInfoMs', label: 'Info gap (ms)' },
  { key: 'gapNoticeMs', label: 'Notice gap (ms)' },
  { key: 'gapAlertMs', label: 'Alert gap (ms)' },
  { key: 'gapCriticalMs', label: 'Critical gap (ms)' },
];

const DETECTION_MODE_OPTIONS = [
  { value: 2, label: 'WiFi + BLE' },
  { value: 0, label: 'WiFi Only' },
  { value: 1, label: 'BLE Only' },
];

const PROTOCOL_OPTIONS = [
  { value: 'meshtastic-like', label: 'Meshtastic JSON/CBOR' },
  { value: 'raw-lines', label: 'Raw Lines' },
  { value: 'nmea-like', label: 'NMEA-like' },
];

const ALERT_COLOR_FIELDS = [
  {
    key: 'alertColorIdle',
    previewKey: 'idle',
    label: 'Idle',
    description: 'Default marker and radius color when no alarms are active.',
  },
  {
    key: 'alertColorInfo',
    previewKey: 'info',
    label: 'Info',
    description: 'Low priority status updates and heartbeat events.',
  },
  {
    key: 'alertColorNotice',
    previewKey: 'notice',
    label: 'Notice',
    description: 'Important events such as new targets or triangulation results.',
  },
  {
    key: 'alertColorAlert',
    previewKey: 'alert',
    label: 'Alert',
    description: 'Actionable events that should prompt operator attention.',
  },
  {
    key: 'alertColorCritical',
    previewKey: 'critical',
    label: 'Critical',
    description: 'Safety-sensitive events such as erase operations or tamper alerts.',
  },
] as const;

type AlertColorFieldKey = (typeof ALERT_COLOR_FIELDS)[number]['key'];
type AlertColorPreviewKey = (typeof ALERT_COLOR_FIELDS)[number]['previewKey'];

const PARITY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'even', label: 'Even' },
  { value: 'odd', label: 'Odd' },
];

const STOP_BITS_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];

const DEFAULT_ALARM_CONFIG: AlarmConfig = {
  audioPack: 'default',
  volumeInfo: 60,
  volumeNotice: 70,
  volumeAlert: 80,
  volumeCritical: 90,
  gapInfoMs: 1000,
  gapNoticeMs: 1500,
  gapAlertMs: 2000,
  gapCriticalMs: 0,
  dndStart: null,
  dndEnd: null,
  backgroundAllowed: false,
};

export function ConfigPage() {
  const queryClient = useQueryClient();

  const updateNodeSiteMeta = useNodeStore((state) => state.updateSiteMeta);
  const {
    settings: alarmSettings,
    isLoading: alarmLoading,
    updateConfig: updateAlarmConfig,
    uploadSound,
    removeSound,
    play,
  } = useAlarm();

  const appSettingsQuery = useQuery({
    queryKey: ['appSettings'],
    queryFn: () => apiClient.get<AppSettings>('/config/app'),
  });

  const serialConfigQuery = useQuery({
    queryKey: ['serialConfig'],
    queryFn: () => apiClient.get<SerialConfig>('/serial/config'),
  });

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
  });
  const mqttSitesQuery = useQuery({
    queryKey: ['mqttSites'],
    queryFn: () => apiClient.get<MqttSiteConfig[]>('/mqtt/sites'),
  });

  const ouiStatsQuery = useQuery({
    queryKey: ['ouiStats'],
    queryFn: () => apiClient.get<{ total: number; lastUpdated?: string | null }>('/oui/stats'),
  });

  const [ouiMode, setOuiMode] = useState<'replace' | 'merge'>('replace');
  const [ouiError, setOuiError] = useState<string | null>(null);

  const [localAlarm, setLocalAlarm] = useState<AlarmConfig>(DEFAULT_ALARM_CONFIG);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [serialConfig, setSerialConfig] = useState<SerialConfig | null>(null);
  const [siteSettings, setSiteSettings] = useState<SiteSummary[]>([]);
  const [mqttConfigs, setMqttConfigs] = useState<MqttSiteConfig[]>([]);
  const [mqttPasswords, setMqttPasswords] = useState<Record<string, string>>({});
  const [mailPasswordInput, setMailPasswordInput] = useState('');
  const [mailPasswordMessage, setMailPasswordMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [serialTestStatus, setSerialTestStatus] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const [configNotice, setConfigNotice] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (alarmSettings?.config) {
      setLocalAlarm(alarmSettings.config);
    }
  }, [alarmSettings?.config]);

  useEffect(() => {
    if (appSettingsQuery.data) {
      setAppSettings(appSettingsQuery.data);
    }
  }, [appSettingsQuery.data]);
  useEffect(() => {
    if (serialConfigQuery.data) {
      setSerialConfig(serialConfigQuery.data);
    }
  }, [serialConfigQuery.data]);

  useEffect(() => {
    if (sitesQuery.data) {
      setSiteSettings(sitesQuery.data);
    }
  }, [sitesQuery.data]);

  useEffect(() => {
    if (mqttSitesQuery.data) {
      setMqttConfigs(mqttSitesQuery.data);
    }
  }, [mqttSitesQuery.data]);

  useEffect(() => {
    if (!configNotice) {
      return;
    }
    const timer = setTimeout(() => setConfigNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [configNotice]);

  useEffect(() => {
    if (serialTestStatus.status === 'success' || serialTestStatus.status === 'error') {
      const timer = setTimeout(() => setSerialTestStatus({ status: 'idle' }), 5000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [serialTestStatus]);

  const sounds = useMemo<Record<AlarmLevel, string | null>>(
    () =>
      alarmSettings?.sounds ?? {
        INFO: null,
        NOTICE: null,
        ALERT: null,
        CRITICAL: null,
      },
    [alarmSettings?.sounds],
  );

  const updateAppSettingsMutation = useMutation({
    mutationFn: (body: AppSettingsUpdate) => apiClient.put<AppSettings>('/config/app', body),
    onSuccess: (data) => {
      queryClient.setQueryData(['appSettings'], data);
      setAppSettings(data);
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Unable to update application settings.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const updateSerialConfigMutation = useMutation({
    mutationFn: (body: Partial<SerialConfig> & { siteId: string }) =>
      apiClient.put<SerialConfig>('/serial/config', body),
    onSuccess: (data) => {
      queryClient.setQueryData(['serialConfig'], data);
      setSerialConfig(data);
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Unable to update serial configuration.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const updateSiteMutation = useMutation({
    mutationFn: ({ siteId, body }: { siteId: string; body: Partial<SiteSummary> }) =>
      apiClient.put<SiteSummary>(`/sites/${siteId}`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(['sites'], (existing: SiteSummary[] | undefined) =>
        existing ? existing.map((site) => (site.id === data.id ? data : site)) : [data],
      );
      setSiteSettings((prev) => prev.map((site) => (site.id === data.id ? data : site)));
      updateNodeSiteMeta(data.id, { name: data.name, color: data.color });
    },
  });
  const updateMqttConfigMutation = useMutation({
    mutationFn: ({
      siteId,
      body,
    }: {
      siteId: string;
      body: Partial<MqttSiteConfig> & { password?: string | null };
    }) => apiClient.put<MqttSiteConfig>(`/mqtt/sites/${siteId}`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(['mqttSites'], (existing: MqttSiteConfig[] | undefined) =>
        existing
          ? existing.map((cfg) => (cfg.siteId === data.siteId ? { ...cfg, ...data } : cfg))
          : [data],
      );
      setMqttConfigs((prev) =>
        prev.map((cfg) => (cfg.siteId === data.siteId ? { ...cfg, ...data } : cfg)),
      );
    },
  });

  const setLocalMqttConfig = (siteId: string, patch: Partial<MqttSiteConfig>) => {
    setMqttConfigs((prev) =>
      prev.map((cfg) => (cfg.siteId === siteId ? { ...cfg, ...patch } : cfg)),
    );
  };

  const commitMqttConfig = (
    siteId: string,
    patch: Partial<MqttSiteConfig> & { password?: string | null },
  ) => {
    updateMqttConfigMutation.mutate({ siteId, body: patch });
  };

  const handleMqttPasswordSubmit = (siteId: string) => {
    const value = mqttPasswords[siteId];
    commitMqttConfig(siteId, { password: value ? value : null });
    setMqttPasswords((prev) => ({ ...prev, [siteId]: '' }));
  };

  const handleMailPasswordSave = async () => {
    if (!appSettings) {
      return;
    }
    try {
      setMailPasswordMessage(null);
      const trimmed = mailPasswordInput.trim();
      const result = await updateAppSettingsMutation.mutateAsync({
        mailPassword: trimmed,
      });
      setMailPasswordInput('');
      setMailPasswordMessage({
        type: 'success',
        text: trimmed.length > 0 ? 'Mail password updated.' : 'Mail password cleared.',
      });
      setAppSettings(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update mail password.';
      setMailPasswordMessage({ type: 'error', text: message });
    }
  };

  const serialTestMutation = useMutation({
    mutationFn: (payload: {
      path?: string;
      baudRate?: number;
      delimiter?: string;
      protocol?: string;
    }) => apiClient.post<SerialState>('/serial/connect', payload),
    onMutate: () => {
      setSerialTestStatus({ status: 'running', message: 'Attempting to connect...' });
    },
    onSuccess: (state) => {
      if (state.connected) {
        setSerialTestStatus({
          status: 'success',
          message:
            `Connected to ${state.path ?? 'device'} ${state.baudRate ? `@ ${state.baudRate} baud` : ''}`.trim(),
        });
        void serialConfigQuery.refetch();
      } else {
        setSerialTestStatus({
          status: 'error',
          message: state.lastError ?? 'Connection attempt completed without link.',
        });
      }
    },
    onError: (error) => {
      setSerialTestStatus({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to connect to serial device.',
      });
    },
  });

  const ouiImportMutation = useMutation({
    mutationFn: ({ file, mode }: { file: File; mode: 'replace' | 'merge' }) => {
      const formData = new FormData();
      formData.append('file', file);
      return apiClient.upload<{ imported: number; total: number; mode: string }>(
        `/oui/import?mode=${mode}`,
        formData,
      );
    },
    onSuccess: () => {
      setOuiError(null);
      queryClient.invalidateQueries({ queryKey: ['ouiStats'] });
    },
    onError: (error) => {
      setOuiError(error instanceof Error ? error.message : 'Failed to import OUI data');
    },
  });

  const updateAppSetting = (patch: Partial<AppSettings>) => {
    if (!appSettings) return;
    const next = { ...appSettings, ...patch };
    setAppSettings(next);
    updateAppSettingsMutation.mutate(patch);
  };

  const handleAlertColorChange =
    (key: AlertColorFieldKey) => (event: ChangeEvent<HTMLInputElement>) => {
      updateAppSetting({ [key]: event.target.value } as Partial<AppSettings>);
    };

  const handleAlertColorReset = (key: AlertColorFieldKey, previewKey: AlertColorPreviewKey) => {
    updateAppSetting({
      [key]: DEFAULT_ALERT_COLORS[previewKey],
    } as Partial<AppSettings>);
  };

  const updateSerialSetting = (patch: Partial<SerialConfig>) => {
    if (!serialConfig) return;
    const next = { ...serialConfig, ...patch };
    setSerialConfig(next);
    updateSerialConfigMutation.mutate({ ...patch, siteId: serialConfig.siteId });
  };

  const updateSiteSetting = (siteId: string, patch: Partial<SiteSummary>) => {
    setSiteSettings((prev) =>
      prev.map((site) => (site.id === siteId ? { ...site, ...patch } : site)),
    );
  };

  const commitSiteSetting = (siteId: string, patch: Partial<SiteSummary>) => {
    const body: Partial<SiteSummary> = {};
    if ('name' in patch) {
      const value = patch.name?.trim();
      if (typeof value === 'string') {
        body.name = value;
      }
    }
    if ('color' in patch) {
      const value = patch.color?.trim();
      if (value) {
        body.color = value.startsWith('#') ? value : `#${value}`;
      }
    }
    if ('region' in patch) {
      const value = patch.region?.trim();
      body.region = value && value.length > 0 ? value : null;
    }
    if (Object.keys(body).length === 0) {
      return;
    }
    updateSiteMutation.mutate({ siteId, body });
  };

  const handleOuiUpload = (file: File) => {
    if (!file) return;
    setOuiError(null);
    ouiImportMutation.mutate({ file, mode: ouiMode });
  };

  const handleJsonFeatureNotice = () => {
    setConfigNotice({
      type: 'info',
      text: 'JSON import/export is not available yet.',
    });
  };

  const handleTestSerial = () => {
    if (!appSettings || !serialConfig) {
      setSerialTestStatus({
        status: 'error',
        message: 'Serial settings are not loaded yet.',
      });
      return;
    }

    const payload: { path?: string; baudRate?: number; delimiter?: string; protocol?: string } = {};
    if (serialConfig.devicePath) {
      payload.path = serialConfig.devicePath;
    }
    if (serialConfig.baud != null) {
      payload.baudRate = serialConfig.baud;
    }
    if (serialConfig.delimiter ?? '') {
      payload.delimiter = serialConfig.delimiter ?? undefined;
    }
    payload.protocol = appSettings.protocol ?? 'meshtastic-like';

    serialTestMutation.mutate(payload);
  };

  const handleOuiExport = (format: 'csv' | 'json') => {
    window.open(`/api/oui/export?format=${format}`, '_blank', 'noopener');
  };

  const formatDateTime = (value?: string | null) =>
    value ? new Date(value).toLocaleString() : 'N/A';

  const ouiStats = ouiStatsQuery.data;

  const handleVolumeChange =
    (level: AlarmLevel, key: keyof AlarmConfig) => (event: ChangeEvent<HTMLInputElement>) => {
      if (!localAlarm) return;
      const value = Number(event.target.value);
      const next = { ...localAlarm, [key]: value } as AlarmConfig;
      setLocalAlarm(next);
      updateAlarmConfig(next);
    };

  const handleGapChange = (key: keyof AlarmConfig) => (event: ChangeEvent<HTMLInputElement>) => {
    if (!localAlarm) return;
    const value = Number(event.target.value);
    const next = { ...localAlarm, [key]: value } as AlarmConfig;
    setLocalAlarm(next);
    updateAlarmConfig(next);
  };

  const handleAudioPackChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (!localAlarm) return;
    const next = { ...localAlarm, audioPack: event.target.value };
    setLocalAlarm(next);
    updateAlarmConfig(next);
  };

  const handleDndChange =
    (key: 'dndStart' | 'dndEnd') => (event: ChangeEvent<HTMLInputElement>) => {
      if (!localAlarm) return;
      const value = event.target.value || null;
      const next = { ...localAlarm, [key]: value };
      setLocalAlarm(next);
      updateAlarmConfig(next);
    };

  const handleBackgroundToggle = (event: ChangeEvent<HTMLInputElement>) => {
    if (!localAlarm) return;
    const next = { ...localAlarm, backgroundAllowed: event.target.checked };
    setLocalAlarm(next);
    updateAlarmConfig(next);
  };

  const isLoading =
    alarmLoading ||
    appSettingsQuery.isLoading ||
    serialConfigQuery.isLoading ||
    !appSettings ||
    !serialConfig;

  if (isLoading) {
    return (
      <section className="panel">
        <header className="panel__header">
          <div>
            <h1 className="panel__title">Configuration</h1>
            <p className="panel__subtitle">Loading configuration.</p>
          </div>
        </header>
        <div className="empty-state">
          <div>Loading configuration.</div>
        </div>
      </section>
    );
  }

  const effectiveAlertColors = extractAlertColors(appSettings!);
  const mailInputsDisabled = !appSettings.mailEnabled;
  const trimmedMailPassword = mailPasswordInput.trim();
  const mailPasswordReady =
    trimmedMailPassword.length > 0 ||
    (appSettings.mailPasswordSet && mailPasswordInput.length === 0);

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Configuration</h1>
          <p className="panel__subtitle">
            Manage appearance, alarms, serial transport, detection defaults, federation, and
            retention.
          </p>
        </div>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            onClick={handleTestSerial}
            disabled={serialTestMutation.isPending}
          >
            {serialTestMutation.isPending ? 'Testing...' : 'Test Serial'}
          </button>
          <button type="button" className="control-chip" onClick={handleJsonFeatureNotice}>
            Import JSON
          </button>
          <button type="button" className="control-chip" onClick={handleJsonFeatureNotice}>
            Export JSON
          </button>
        </div>
        {configNotice ? (
          <div
            className={
              configNotice.type === 'error'
                ? 'form-error'
                : configNotice.type === 'success'
                  ? 'form-success'
                  : 'form-hint'
            }
            role={configNotice.type === 'error' ? 'alert' : 'status'}
          >
            {configNotice.text}
          </div>
        ) : null}
        {serialTestStatus.status !== 'idle' ? (
          <div
            className={
              serialTestStatus.status === 'error'
                ? 'form-error'
                : serialTestStatus.status === 'success'
                  ? 'form-success'
                  : 'form-hint'
            }
          >
            {serialTestStatus.message}
          </div>
        ) : null}
      </header>

      <div className="config-grid">
        <section className="config-card">
          <header>
            <h2>Alarm Profiles</h2>
            <p>Adjust volume, rate limit, and audio tone for each alarm level.</p>
          </header>
          <div className="config-card__body">
            <div className="config-row">
              <span className="config-label">Sound Pack</span>
              <select value={localAlarm.audioPack} onChange={handleAudioPackChange}>
                <option value="default">Default</option>
                <option value="quiet">Quiet</option>
                <option value="ops">Operations</option>
              </select>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={localAlarm.backgroundAllowed}
                onChange={handleBackgroundToggle}
              />
              Allow audio playback when the console tab is in the background
            </label>
          </div>
          <div className="config-card__body alarm-grid">
            {Object.entries(LEVEL_METADATA).map(([level, meta]) => {
              const alarmLevel = level as AlarmLevel;
              const volumeKey = volumeKeyForLevel(alarmLevel);
              const volumeValue = (localAlarm[volumeKey] ?? 0) as number;
              return (
                <div key={alarmLevel} className="alarm-level-card">
                  <div className="alarm-header">
                    <h3>{meta.label}</h3>
                    <span>{meta.description}</span>
                  </div>
                  <div className="alarm-controls">
                    <label>
                      Volume: {volumeValue}%
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={volumeValue}
                        onChange={handleVolumeChange(alarmLevel, volumeKey)}
                      />
                    </label>
                    <div className="alarm-sound-row">
                      <div className="sound-file">
                        {sounds[alarmLevel] ? 'Custom sound uploaded' : 'Using default tone'}
                      </div>
                      <div className="sound-actions">
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => play(alarmLevel)}
                        >
                          Preview
                        </button>
                        <label className="control-chip">
                          Upload
                          <input
                            type="file"
                            accept="audio/*"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) {
                                uploadSound(alarmLevel, file);
                                event.target.value = '';
                              }
                            }}
                            hidden
                          />
                        </label>
                        <button
                          type="button"
                          className="control-chip"
                          disabled={!sounds[alarmLevel]}
                          onClick={() => removeSound(alarmLevel)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>Alarm Cooldowns</h2>
            <p>Define the minimum interval between repeated alarms of the same level.</p>
          </header>
          <div className="config-card__body">
            {GAPS.map(({ key, label }) => {
              const gapValue = (localAlarm[key] ?? 0) as number;
              return (
                <div className="config-row" key={key}>
                  <span className="config-label">{label}</span>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={gapValue}
                    onChange={handleGapChange(key)}
                  />
                </div>
              );
            })}
            <div className="config-row">
              <span className="config-label">Do-not-disturb start</span>
              <input
                type="time"
                value={localAlarm.dndStart ?? ''}
                onChange={handleDndChange('dndStart')}
              />
            </div>
            <div className="config-row">
              <span className="config-label">Do-not-disturb end</span>
              <input
                type="time"
                value={localAlarm.dndEnd ?? ''}
                onChange={handleDndChange('dndEnd')}
              />
            </div>
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>Mail Server</h2>
            <p>Configure SMTP delivery for invitations and alert notifications.</p>
          </header>
          <div className="config-card__body">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={appSettings.mailEnabled}
                onChange={(event) => updateAppSetting({ mailEnabled: event.target.checked })}
              />
              Enable outbound email
            </label>
            <div className="config-row">
              <span className="config-label">SMTP Host</span>
              <input
                placeholder="smtp.example.com"
                value={appSettings.mailHost ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  updateAppSetting({ mailHost: value.trim().length > 0 ? value.trim() : null });
                }}
                disabled={mailInputsDisabled}
              />
              <span className="config-hint">
                Fully qualified domain or IP that the backend can reach, e.g. smtp.yourdomain.com.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">SMTP Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={appSettings.mailPort ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw.trim().length === 0) {
                    updateAppSetting({ mailPort: null });
                    return;
                  }
                  const value = Number(raw);
                  if (!Number.isFinite(value)) {
                    return;
                  }
                  updateAppSetting({ mailPort: value });
                }}
                disabled={mailInputsDisabled}
              />
              <span className="config-hint">
                Common ports: 587 for STARTTLS, 465 for SMTPS, 25 for unencrypted relays.
              </span>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={appSettings.mailSecure}
                onChange={(event) => updateAppSetting({ mailSecure: event.target.checked })}
                disabled={mailInputsDisabled}
              />
              Use TLS (secure connection)
            </label>
            <span className="config-hint">
              Enable for STARTTLS/SMTPS. Disable only if your relay explicitly requires plain-text
              connections.
            </span>
            <div className="config-row">
              <span className="config-label">Username</span>
              <input
                value={appSettings.mailUser ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  updateAppSetting({ mailUser: value.trim().length > 0 ? value.trim() : null });
                }}
                disabled={mailInputsDisabled}
              />
              <span className="config-hint">
                Optional login for authenticated SMTP. Leave blank for IP/hostname based relays.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">From Address</span>
              <input
                value={appSettings.mailFrom}
                onChange={(event) => updateAppSetting({ mailFrom: event.target.value })}
                disabled={mailInputsDisabled}
              />
              <span className="field-hint">Shown as the sender on outbound messages.</span>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={appSettings.mailPreview}
                onChange={(event) => updateAppSetting({ mailPreview: event.target.checked })}
                disabled={mailInputsDisabled}
              />
              Capture mail in local preview instead of sending
            </label>
            <span className="config-hint">
              When enabled, emails are written to disk for inspection and never delivered to
              external servers.
            </span>
            <div className="config-row">
              <span className="config-label">Password</span>
              <div className="mail-password-row">
                <input
                  type="password"
                  value={mailPasswordInput}
                  placeholder={appSettings.mailPasswordSet ? '********' : 'Enter SMTP password'}
                  onChange={(event) => setMailPasswordInput(event.target.value)}
                  disabled={mailInputsDisabled}
                />
                <button
                  type="button"
                  className="control-chip"
                  onClick={handleMailPasswordSave}
                  disabled={
                    mailInputsDisabled || !mailPasswordReady || updateAppSettingsMutation.isPending
                  }
                >
                  Save Password
                </button>
              </div>
              <span className="field-hint">
                {appSettings.mailPasswordSet
                  ? 'A password is stored securely on the server.'
                  : 'No password stored yet.'}
              </span>
              {mailPasswordMessage ? (
                <div
                  className={mailPasswordMessage.type === 'error' ? 'form-error' : 'form-success'}
                  role={mailPasswordMessage.type === 'error' ? 'alert' : 'status'}
                >
                  {mailPasswordMessage.text}
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>Security Defaults</h2>
            <p>Set application URLs and token expiry policies.</p>
          </header>
          <div className="config-card__body">
            <div className="config-row">
              <span className="config-label">Application URL</span>
              <input
                type="url"
                placeholder="https://command-center.example.com"
                value={appSettings.securityAppUrl}
                onChange={(event) => updateAppSetting({ securityAppUrl: event.target.value })}
              />
              <span className="field-hint">Used in email templates and deep links.</span>
            </div>
            <div className="config-row">
              <span className="config-label">Invitation expiry (hours)</span>
              <input
                type="number"
                min={1}
                value={appSettings.invitationExpiryHours}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ invitationExpiryHours: value });
                }}
              />
            </div>
            <div className="config-row">
              <span className="config-label">Password reset expiry (hours)</span>
              <input
                type="number"
                min={1}
                value={appSettings.passwordResetExpiryHours}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ passwordResetExpiryHours: value });
                }}
              />
            </div>
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>Alert Colors</h2>
            <p>Customize map marker and radius colors for each alarm level.</p>
          </header>
          <div className="config-card__body">
            <div className="alert-color-grid">
              {ALERT_COLOR_FIELDS.map((field) => {
                const previewColor = effectiveAlertColors[field.previewKey];
                const isDefault =
                  previewColor.toUpperCase() === DEFAULT_ALERT_COLORS[field.previewKey];
                return (
                  <div key={field.key} className="alert-color-item">
                    <div className="alert-color-preview">
                      <input
                        type="color"
                        value={previewColor}
                        onChange={handleAlertColorChange(field.key)}
                        aria-label={`${field.label} Color`}
                      />
                    </div>
                    <div className="alert-color-details">
                      <span className="config-label">{field.label}</span>
                      <div className="alert-color-code">{previewColor}</div>
                      <p className="field-hint">{field.description}</p>
                      <div className="alert-color-actions">
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => handleAlertColorReset(field.key, field.previewKey)}
                          disabled={isDefault}
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>Site Settings</h2>
            <p>Update site names and colors for multi-site deployments.</p>
          </header>
          <div className="config-card__body">
            {sitesQuery.isLoading ? (
              <div>Loading site metadata...</div>
            ) : sitesQuery.isError ? (
              <div className="form-error">Unable to load site list.</div>
            ) : siteSettings.length === 0 ? (
              <div className="empty-state">
                <div>No sites found. Create a site in the database to manage settings here.</div>
              </div>
            ) : (
              siteSettings.map((site) => (
                <div key={site.id} className="config-subcard">
                  <div className="config-row">
                    <span className="config-label">Site ID</span>
                    <span className="muted">{site.id}</span>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Name</span>
                    <input
                      value={site.name}
                      onChange={(event) => updateSiteSetting(site.id, { name: event.target.value })}
                      onBlur={(event) => {
                        const trimmed = event.target.value.trim();
                        updateSiteSetting(site.id, { name: trimmed });
                        commitSiteSetting(site.id, { name: trimmed });
                      }}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Display Color</span>
                    <div className="site-color-row">
                      <input
                        type="color"
                        value={site.color || '#0f62fe'}
                        onChange={(event) => {
                          const color = event.target.value;
                          updateSiteSetting(site.id, { color });
                          commitSiteSetting(site.id, { color });
                        }}
                        aria-label={`${site.name || site.id} color`}
                      />
                      <input
                        value={site.color ?? ''}
                        placeholder="#0f62fe"
                        onChange={(event) =>
                          updateSiteSetting(site.id, { color: event.target.value })
                        }
                        onBlur={(event) => {
                          const raw = event.target.value.trim();
                          if (!raw) {
                            return;
                          }
                          const sanitized = raw.startsWith('#') ? raw : `#${raw}`;
                          updateSiteSetting(site.id, { color: sanitized });
                          commitSiteSetting(site.id, { color: sanitized });
                        }}
                      />
                    </div>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Region</span>
                    <input
                      value={site.region ?? ''}
                      placeholder="Optional"
                      onChange={(event) =>
                        updateSiteSetting(site.id, {
                          region: event.target.value === '' ? null : event.target.value,
                        })
                      }
                      onBlur={(event) =>
                        commitSiteSetting(site.id, {
                          region: event.target.value === '' ? null : event.target.value.trim(),
                        })
                      }
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>Serial Connection</h2>
            <p>Review connection defaults and rate limits.</p>
          </header>
          <div className="config-card__body">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={serialConfig.enabled}
                onChange={(event) => updateSerialSetting({ enabled: event.target.checked })}
              />
              Enable serial auto-connect
            </label>
            <span className="config-hint">
              When enabled, the ingest service reconnects automatically using the settings below.
            </span>
            <div className="config-row">
              <span className="config-label">Device Path</span>
              <input
                placeholder="/dev/ttyUSB0"
                value={serialConfig.devicePath ?? ''}
                onChange={(event) =>
                  updateSerialSetting({ devicePath: event.target.value || null })
                }
              />
              <span className="config-hint">
                Path to the radio / serial bridge. On Windows use COM ports, on Linux use /dev/tty*.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Baud Rate</span>
              <input
                type="number"
                placeholder="115200"
                value={serialConfig.baud ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === '') {
                    updateSerialSetting({ baud: null });
                    return;
                  }
                  const value = Number(raw);
                  if (!Number.isFinite(value)) return;
                  updateSerialSetting({ baud: value });
                }}
              />
              <span className="config-hint">
                Must match the firmware setting on the connected device (115200 for Meshtastic).
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Protocol</span>
              <select
                value={appSettings.protocol}
                onChange={(event) => updateAppSetting({ protocol: event.target.value })}
              >
                {PROTOCOL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="config-hint">
                Select the parser that matches the incoming frame format on the wire.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Data Bits</span>
              <input
                type="number"
                min={5}
                max={9}
                value={serialConfig.dataBits ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === '') {
                    updateSerialSetting({ dataBits: null });
                    return;
                  }
                  const value = Number(raw);
                  if (!Number.isFinite(value)) return;
                  updateSerialSetting({ dataBits: value });
                }}
              />
              <span className="config-hint">
                Most serial radios use 8 data bits. Adjust only for specialized hardware.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Parity</span>
              <select
                value={serialConfig.parity ?? 'none'}
                onChange={(event) => updateSerialSetting({ parity: event.target.value })}
              >
                {PARITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="config-hint">
                Leave as None unless the device requires parity bits for error checking.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Stop Bits</span>
              <select
                value={serialConfig.stopBits ?? 1}
                onChange={(event) => updateSerialSetting({ stopBits: Number(event.target.value) })}
              >
                {STOP_BITS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="config-hint">
                Typically 1; some equipment expects 2 stop bits on slower links.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Delimiter</span>
              <input
                placeholder="auto (default)"
                value={serialConfig.delimiter ?? ''}
                onChange={(event) => updateSerialSetting({ delimiter: event.target.value || null })}
                title="Use 'auto' to try CRLF and LF automatically. Common values: \n, \r\n."
              />
              <span className="config-hint">
                Line ending used to split incoming frames. Leave blank for automatic detection.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Reconnect Base (ms)</span>
              <input
                type="number"
                value={serialConfig.reconnectBaseMs ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === '') {
                    updateSerialSetting({ reconnectBaseMs: null });
                    return;
                  }
                  const value = Number(raw);
                  if (!Number.isFinite(value)) return;
                  updateSerialSetting({ reconnectBaseMs: value });
                }}
              />
              <span className="config-hint">
                Initial backoff delay before retrying a disconnected serial link.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Reconnect Max (ms)</span>
              <input
                type="number"
                value={serialConfig.reconnectMaxMs ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === '') {
                    updateSerialSetting({ reconnectMaxMs: null });
                    return;
                  }
                  const value = Number(raw);
                  if (!Number.isFinite(value)) return;
                  updateSerialSetting({ reconnectMaxMs: value });
                }}
              />
              <span className="config-hint">
                Upper bound for exponential backoff between reconnection attempts.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Reconnect Jitter</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={serialConfig.reconnectJitter ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === '') {
                    updateSerialSetting({ reconnectJitter: null });
                    return;
                  }
                  const value = Number(raw);
                  if (!Number.isFinite(value)) return;
                  updateSerialSetting({ reconnectJitter: value });
                }}
              />
            </div>
            <div className="config-row">
              <span className="config-label">Reconnect Attempts</span>
              <input
                type="number"
                min={0}
                value={serialConfig.reconnectMaxAttempts ?? ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === '') {
                    updateSerialSetting({ reconnectMaxAttempts: null });
                    return;
                  }
                  const value = Number(raw);
                  if (!Number.isFinite(value)) return;
                  updateSerialSetting({ reconnectMaxAttempts: value });
                }}
              />
            </div>
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>MQTT Federation</h2>
            <p>Configure broker connectivity for remote sites and command replication.</p>
          </header>
          <div className="config-card__body">
            {mqttSitesQuery.isLoading ? (
              <div>Loading MQTT configuration...</div>
            ) : mqttSitesQuery.isError ? (
              <div className="form-error">
                Unable to load MQTT configuration. Check backend logs.
              </div>
            ) : mqttConfigs.length === 0 ? (
              <div className="empty-state">
                <div>No MQTT sites configured yet. Add a site to enable federation.</div>
              </div>
            ) : (
              mqttConfigs.map((cfg) => (
                <div key={cfg.siteId} className="config-subcard">
                  <div className="config-row">
                    <span className="config-label">Site</span>
                    <div className="config-value">
                      <strong>{cfg.site?.name ?? cfg.siteId}</strong>
                      <span className="muted">{cfg.siteId}</span>
                    </div>
                  </div>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={cfg.enabled}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        setLocalMqttConfig(cfg.siteId, { enabled });
                        commitMqttConfig(cfg.siteId, { enabled });
                      }}
                    />
                    Enable site replication
                  </label>
                  <div className="config-row">
                    <span className="config-label">Broker URL</span>
                    <input
                      value={cfg.brokerUrl}
                      onChange={(event) =>
                        setLocalMqttConfig(cfg.siteId, { brokerUrl: event.target.value })
                      }
                      onBlur={(event) =>
                        commitMqttConfig(cfg.siteId, { brokerUrl: event.target.value })
                      }
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Client ID</span>
                    <input
                      value={cfg.clientId}
                      onChange={(event) =>
                        setLocalMqttConfig(cfg.siteId, { clientId: event.target.value })
                      }
                      onBlur={(event) =>
                        commitMqttConfig(cfg.siteId, { clientId: event.target.value })
                      }
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Username</span>
                    <input
                      value={cfg.username ?? ''}
                      onChange={(event) =>
                        setLocalMqttConfig(cfg.siteId, { username: event.target.value || null })
                      }
                      onBlur={(event) =>
                        commitMqttConfig(cfg.siteId, {
                          username: event.target.value || null,
                        })
                      }
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Password</span>
                    <div className="mqtt-password-row">
                      <input
                        type="password"
                        value={mqttPasswords[cfg.siteId] ?? ''}
                        placeholder={cfg.username ? 'Enter new password' : 'Optional'}
                        onChange={(event) =>
                          setMqttPasswords((prev) => ({
                            ...prev,
                            [cfg.siteId]: event.target.value,
                          }))
                        }
                      />
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => handleMqttPasswordSubmit(cfg.siteId)}
                        disabled={!mqttPasswords[cfg.siteId]}
                      >
                        Update
                      </button>
                    </div>
                  </div>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={cfg.tlsEnabled}
                      onChange={(event) => {
                        const tlsEnabled = event.target.checked;
                        setLocalMqttConfig(cfg.siteId, { tlsEnabled });
                        commitMqttConfig(cfg.siteId, { tlsEnabled });
                      }}
                    />
                    TLS enabled
                  </label>
                  <div className="config-row">
                    <span className="config-label">QoS (events)</span>
                    <select
                      value={cfg.qosEvents}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setLocalMqttConfig(cfg.siteId, { qosEvents: value });
                        commitMqttConfig(cfg.siteId, { qosEvents: value });
                      }}
                    >
                      {[0, 1, 2].map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="config-row">
                    <span className="config-label">QoS (commands)</span>
                    <select
                      value={cfg.qosCommands}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        setLocalMqttConfig(cfg.siteId, { qosCommands: value });
                        commitMqttConfig(cfg.siteId, { qosCommands: value });
                      }}
                    >
                      {[0, 1, 2].map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="config-row">
                    <span className="config-label">CA PEM</span>
                    <textarea
                      rows={3}
                      value={cfg.caPem ?? ''}
                      onChange={(event) =>
                        setLocalMqttConfig(cfg.siteId, { caPem: event.target.value || null })
                      }
                      onBlur={(event) =>
                        commitMqttConfig(cfg.siteId, { caPem: event.target.value || null })
                      }
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Client Cert PEM</span>
                    <textarea
                      rows={3}
                      value={cfg.certPem ?? ''}
                      onChange={(event) =>
                        setLocalMqttConfig(cfg.siteId, { certPem: event.target.value || null })
                      }
                      onBlur={(event) =>
                        commitMqttConfig(cfg.siteId, { certPem: event.target.value || null })
                      }
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Client Key PEM</span>
                    <textarea
                      rows={3}
                      value={cfg.keyPem ?? ''}
                      onChange={(event) =>
                        setLocalMqttConfig(cfg.siteId, { keyPem: event.target.value || null })
                      }
                      onBlur={(event) =>
                        commitMqttConfig(cfg.siteId, { keyPem: event.target.value || null })
                      }
                    />
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>Detection Defaults</h2>
            <p>Preset channels and durations for scan/baseline workflows.</p>
          </header>
          <div className="config-card__body">
            <div className="config-row">
              <span className="config-label">Mode</span>
              <select
                value={appSettings.detectMode}
                onChange={(event) => updateAppSetting({ detectMode: Number(event.target.value) })}
              >
                {DETECTION_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="config-hint">
                Default interface mix used when operators start a new scan (WiFi, BLE, or both).
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Channels</span>
              <input
                placeholder="1..14"
                value={appSettings.detectChannels}
                onChange={(event) => updateAppSetting({ detectChannels: event.target.value })}
              />
              <span className="config-hint">
                Accepts comma-separated channels or ranges (e.g. 1,6,11 or 1..14). Applied to
                quick-start presets.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Scan Duration (s)</span>
              <input
                type="number"
                value={appSettings.detectScanSecs}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ detectScanSecs: value });
                }}
              />
              <span className="config-hint">
                Baseline length for general scans before results are returned.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Device Scan Duration (s)</span>
              <input
                type="number"
                value={appSettings.deviceScanSecs}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ deviceScanSecs: value });
                }}
              />
              <span className="config-hint">
                Used when operators launch inventory-focused sweeps.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Baseline Duration (s)</span>
              <input
                type="number"
                value={appSettings.baselineSecs}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ baselineSecs: value });
                }}
              />
              <span className="config-hint">
                Time allowed for sites to capture a quiet profile before anomaly detection starts.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Randomization Duration (s)</span>
              <input
                type="number"
                value={appSettings.randomizeSecs}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ randomizeSecs: value });
                }}
              />
              <span className="config-hint">
                Duration for MAC randomization sweeps triggered from the console.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Drone Duration (s)</span>
              <input
                type="number"
                value={appSettings.droneSecs}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ droneSecs: value });
                }}
              />
              <span className="config-hint">
                How long RID monitoring runs before automatically stopping.
              </span>
            </div>
            <div className="config-row">
              <span className="config-label">Deauth Duration (s)</span>
              <input
                type="number"
                value={appSettings.deauthSecs}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ deauthSecs: value });
                }}
              />
              <span className="config-hint">
                Time limit for deauthentication campaigns to avoid accidental long runs.
              </span>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={appSettings.allowForever}
                onChange={(event) => updateAppSetting({ allowForever: event.target.checked })}
              />
              Allow FOREVER commands
            </label>
            <span className="config-hint">
              Permit operators to schedule indefinite tasks (requires explicit STOP to end).
            </span>
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>Map & Coverage</h2>
            <p>Tiles, attribution, and coverage radius defaults.</p>
          </header>
          <div className="config-card__body">
            <div className="config-row">
              <span className="config-label">Map Tile URL</span>
              <input
                placeholder="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                value={appSettings.mapTileUrl}
                onChange={(event) => updateAppSetting({ mapTileUrl: event.target.value })}
              />
            </div>
            <div className="config-row">
              <span className="config-label">Attribution</span>
              <input
                value={appSettings.mapAttribution}
                onChange={(event) => updateAppSetting({ mapAttribution: event.target.value })}
              />
            </div>
            <div className="config-row">
              <span className="config-label">Default Radius (m)</span>
              <input
                type="number"
                value={appSettings.defaultRadiusM}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ defaultRadiusM: value });
                }}
              />
            </div>
            <div className="config-row">
              <span className="config-label">Min Zoom</span>
              <input
                type="number"
                value={appSettings.minZoom}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ minZoom: value });
                }}
              />
            </div>
            <div className="config-row">
              <span className="config-label">Max Zoom</span>
              <input
                type="number"
                value={appSettings.maxZoom}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (!Number.isFinite(value)) return;
                  updateAppSetting({ maxZoom: value });
                }}
              />
            </div>
          </div>
        </section>

        <section className="config-card">
          <header>
            <h2>OUI Resolver</h2>
            <p>Manage vendor lookup cache for MAC address resolution.</p>
          </header>
          <div className="config-card__body">
            <div className="config-row">
              <span className="config-label">Total entries</span>
              <span>{ouiStats ? ouiStats.total.toLocaleString() : 'N/A'}</span>
            </div>
            <div className="config-row">
              <span className="config-label">Last updated</span>
              <span>{formatDateTime(ouiStats?.lastUpdated ?? null)}</span>
            </div>
            {ouiError ? <div className="form-error">{ouiError}</div> : null}
            <div className="config-row">
              <span className="config-label">Import mode</span>
              <select
                value={ouiMode}
                onChange={(event) => setOuiMode(event.target.value as 'replace' | 'merge')}
              >
                <option value="replace">Replace existing</option>
                <option value="merge">Merge</option>
              </select>
            </div>
            <label className="control-chip">
              {ouiImportMutation.isPending ? 'Uploading...' : 'Upload CSV/JSON'}
              <input
                type="file"
                accept=".csv,.json,text/csv,application/json"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    handleOuiUpload(file);
                    event.target.value = '';
                  }
                }}
              />
            </label>
            <div className="controls-row">
              <button type="button" className="control-chip" onClick={() => handleOuiExport('csv')}>
                Export CSV
              </button>
              <button
                type="button"
                className="control-chip"
                onClick={() => handleOuiExport('json')}
              >
                Export JSON
              </button>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

function volumeKeyForLevel(level: AlarmLevel): keyof AlarmConfig {
  switch (level) {
    case 'INFO':
      return 'volumeInfo';
    case 'NOTICE':
      return 'volumeNotice';
    case 'ALERT':
      return 'volumeAlert';
    case 'CRITICAL':
      return 'volumeCritical';
  }
}
