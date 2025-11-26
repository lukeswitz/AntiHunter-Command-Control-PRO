import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import { apiClient } from '../api/client';
import type { AlarmConfig, AlarmLevel, AlarmSettingsResponse, AlarmSoundKey } from '../api/types';

type AlarmContextValue = {
  settings?: AlarmSettingsResponse;
  isLoading: boolean;
  play: (level: AlarmLevel) => void;
  playDroneGeofence: () => void;
  playDroneTelemetry: () => void;
  updateConfig: (config: AlarmConfig) => void;
  uploadSound: (level: AlarmSoundKey, file: File) => void;
  removeSound: (level: AlarmSoundKey) => void;
};

const AlarmContext = createContext<AlarmContextValue | undefined>(undefined);

const LEVELS: AlarmLevel[] = ['INFO', 'NOTICE', 'ALERT', 'CRITICAL'];
const EXTRA_SOUND_KEYS: AlarmSoundKey[] = ['DRONE_GEOFENCE', 'DRONE_TELEMETRY'];
const SOUND_KEYS: AlarmSoundKey[] = [...LEVELS, ...EXTRA_SOUND_KEYS];
const DRONE_GEOFENCE_GAP_MS = 2000;
const DRONE_TELEMETRY_GAP_MS = 1500;

const MEDIA_PROTOCOL_REGEX = /^https?:\/\//i;
const BLOB_PROTOCOL_REGEX = /^blob:/i;
function resolveMediaUrl(path: string | null): string | null {
  if (!path) {
    return null;
  }
  if (MEDIA_PROTOCOL_REGEX.test(path)) {
    return path;
  }
  if (BLOB_PROTOCOL_REGEX.test(path)) {
    return path;
  }
  if (typeof window === 'undefined') {
    return path;
  }
  const base = window.location.origin.replace(/\/$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${base}${normalized}`;
}

function createFallbackTone(level: AlarmLevel, volumePercent: number) {
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'triangle';
  const frequencies: Record<AlarmLevel, number> = {
    INFO: 440,
    NOTICE: 660,
    ALERT: 880,
    CRITICAL: 1040,
  };
  oscillator.frequency.value = frequencies[level];
  const normalized = Math.max(0, Math.min(1, volumePercent / 100));
  gain.gain.value = Math.max(0.02, normalized * 0.4);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();
  oscillator.stop(ctx.currentTime + 0.5);
  oscillator.addEventListener('ended', () => ctx.close());
}

export function AlarmProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const audioRefs = useRef<Record<AlarmSoundKey, HTMLAudioElement | null>>({
    INFO: null,
    NOTICE: null,
    ALERT: null,
    CRITICAL: null,
    DRONE_GEOFENCE: null,
    DRONE_TELEMETRY: null,
  });
  const objectUrlsRef = useRef<Record<AlarmSoundKey, string | undefined>>({
    INFO: undefined,
    NOTICE: undefined,
    ALERT: undefined,
    CRITICAL: undefined,
    DRONE_GEOFENCE: undefined,
    DRONE_TELEMETRY: undefined,
  });
  const configRef = useRef<AlarmConfig | undefined>(undefined);
  const lastPlayedRef = useRef<Record<AlarmSoundKey, number>>({
    INFO: 0,
    NOTICE: 0,
    ALERT: 0,
    CRITICAL: 0,
    DRONE_GEOFENCE: 0,
    DRONE_TELEMETRY: 0,
  });

  const applyAudioVolumes = (config: AlarmConfig | undefined) => {
    LEVELS.forEach((level) => {
      const audio = audioRefs.current[level];
      if (audio) {
        audio.volume = (configToVolume(config, level) ?? 60) / 100;
      }
    });
  };

  const settingsQuery = useQuery({
    queryKey: ['alarms'],
    queryFn: () => apiClient.get<AlarmSettingsResponse>('/alarms'),
  });

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    const { config, sounds } = settingsQuery.data;
    configRef.current = config;
    SOUND_KEYS.forEach((level) => {
      const existing = audioRefs.current[level];
      if (existing) {
        existing.pause();
        existing.currentTime = 0;
      }
      const src = resolveMediaUrl(sounds[level]);
      if (!src) {
        audioRefs.current[level] = null;
        return;
      }
      const audio = new Audio(src);
      audio.preload = 'auto';
      audio.volume = (volumeForSoundKey(config, level) ?? 60) / 100;
      audio.crossOrigin = 'anonymous';
      audio.load();
      audioRefs.current[level] = audio;
    });
  }, [settingsQuery.data]);

  const updateConfigMutation = useMutation({
    mutationFn: (body: AlarmConfig) => {
      // eslint-disable-next-line no-console
      console.log('Alarm mutation called with:', body);
      return apiClient.put<AlarmSettingsResponse>('/alarms', body);
    },
    onMutate: async (_body: AlarmConfig) => {
      const previous = queryClient.getQueryData<AlarmSettingsResponse>(['alarms']);
      // Don't do optimistic updates - wait for server confirmation
      return { previous };
    },
    onError: (error, body, context) => {
      // eslint-disable-next-line no-console
      console.error('Failed to update alarm config:', error);
      // eslint-disable-next-line no-console
      console.error('Body that failed:', body);
      if (context?.previous) {
        queryClient.setQueryData(['alarms'], context.previous);
        configRef.current = context.previous.config;
        applyAudioVolumes(context.previous.config);
      }
    },
    onSuccess: (data) => {
      // eslint-disable-next-line no-console
      console.log('Alarm config update succeeded:', data);
      queryClient.setQueryData(['alarms'], data);
      configRef.current = data.config;
      applyAudioVolumes(data.config);
    },
  });

  const uploadSoundMutation = useMutation<
    AlarmSettingsResponse,
    Error,
    { level: AlarmSoundKey; file: File },
    { previous?: AlarmSettingsResponse; level: AlarmSoundKey }
  >({
    mutationFn: ({ level, file }: { level: AlarmSoundKey; file: File }) => {
      const formData = new FormData();
      formData.append('file', file);
      return apiClient.upload<AlarmSettingsResponse>(`/alarms/sounds/${level}`, formData);
    },
    onMutate: async ({ level, file }) => {
      const previous = queryClient.getQueryData<AlarmSettingsResponse>(['alarms']);
      const objectUrl = URL.createObjectURL(file);
      const existingUrl = objectUrlsRef.current[level];
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl);
      }
      objectUrlsRef.current[level] = objectUrl;

      const tempAudio = new Audio(objectUrl);
      tempAudio.preload = 'auto';
      tempAudio.volume =
        ((previous ? volumeForSoundKey(previous.config, level) : undefined) ?? 60) / 100;
      tempAudio.load();
      audioRefs.current[level]?.pause();
      audioRefs.current[level] = tempAudio;

      if (previous) {
        queryClient.setQueryData<AlarmSettingsResponse>(['alarms'], {
          config: previous.config,
          sounds: {
            ...previous.sounds,
            [level]: objectUrl,
          },
        });
      }

      return { previous, level };
    },
    onSuccess: (data, variables) => {
      queryClient.setQueryData(['alarms'], data);
      const url = objectUrlsRef.current[variables.level];
      if (url) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current[variables.level] = undefined;
      }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['alarms'], context.previous);
      }
      if (context) {
        const url = objectUrlsRef.current[context.level];
        if (url) {
          URL.revokeObjectURL(url);
          objectUrlsRef.current[context.level] = undefined;
        }
      }
    },
  });

  const removeSoundMutation = useMutation({
    mutationFn: (level: AlarmSoundKey) =>
      apiClient.delete<AlarmSettingsResponse>(`/alarms/sounds/${level}`),
    onSuccess: (data) => queryClient.setQueryData(['alarms'], data),
  });

  const play = useCallback(
    (level: AlarmLevel) => {
      const config = configRef.current ?? settingsQuery.data?.config;
      const now = Date.now();

      if (config) {
        const gap = gapForLevel(config, level);
        if (gap > 0 && now - lastPlayedRef.current[level] < gap) {
          return;
        }

        if (isWithinDndWindow(config, level)) {
          return;
        }

        if (
          typeof document !== 'undefined' &&
          document.hidden &&
          !config.backgroundAllowed &&
          level !== 'CRITICAL'
        ) {
          return;
        }
      }

      const audio = audioRefs.current[level];
      const volume = configToVolume(config, level) ?? 60;
      if (audio) {
        audio.volume = volume / 100;
        audio.currentTime = 0;
        void audio.play().catch((error) => {
          if (typeof window !== 'undefined') {
            // eslint-disable-next-line no-console -- surface playback issues for operators
            console.warn(`Failed to play alarm ${level}:`, error);
          }
          createFallbackTone(level, volume);
        });
        lastPlayedRef.current[level] = now;
        return;
      }
      createFallbackTone(level, volume);
      lastPlayedRef.current[level] = now;
    },
    [settingsQuery.data],
  );

  const playDroneGeofence = useCallback(() => {
    const config = configRef.current ?? settingsQuery.data?.config;
    const now = Date.now();
    if (now - lastPlayedRef.current.DRONE_GEOFENCE < DRONE_GEOFENCE_GAP_MS) {
      return;
    }

    const audio = audioRefs.current.DRONE_GEOFENCE;
    const volume = volumeForSoundKey(config, 'DRONE_GEOFENCE');
    if (audio) {
      audio.volume = volume / 100;
      audio.currentTime = 0;
      void audio.play().catch((error) => {
        if (typeof window !== 'undefined') {
          // eslint-disable-next-line no-console
          console.warn('Failed to play drone geofence alarm:', error);
        }
        createFallbackTone('ALERT', volume);
      });
    } else {
      createFallbackTone('ALERT', volume);
    }
    lastPlayedRef.current.DRONE_GEOFENCE = now;
  }, [settingsQuery.data]);

  const playDroneTelemetry = useCallback(() => {
    const config = configRef.current ?? settingsQuery.data?.config;
    const now = Date.now();
    if (now - lastPlayedRef.current.DRONE_TELEMETRY < DRONE_TELEMETRY_GAP_MS) {
      return;
    }

    const audio = audioRefs.current.DRONE_TELEMETRY;
    const volume = volumeForSoundKey(config, 'DRONE_TELEMETRY');
    if (audio) {
      audio.volume = volume / 100;
      audio.currentTime = 0;
      void audio.play().catch((error) => {
        if (typeof window !== 'undefined') {
          // eslint-disable-next-line no-console
          console.warn('Failed to play drone telemetry alarm:', error);
        }
        createFallbackTone('NOTICE', volume);
      });
    } else {
      createFallbackTone('NOTICE', volume);
    }
    lastPlayedRef.current.DRONE_TELEMETRY = now;
  }, [settingsQuery.data]);

  const value = useMemo<AlarmContextValue>(
    () => ({
      settings: settingsQuery.data,
      isLoading: settingsQuery.isLoading,
      play,
      playDroneGeofence,
      playDroneTelemetry,
      updateConfig: (config) => updateConfigMutation.mutate(config),
      uploadSound: (level, file) => uploadSoundMutation.mutate({ level, file }),
      removeSound: (level) => removeSoundMutation.mutate(level),
    }),
    [
      settingsQuery.data,
      settingsQuery.isLoading,
      play,
      playDroneGeofence,
      playDroneTelemetry,
      updateConfigMutation,
      uploadSoundMutation,
      removeSoundMutation,
    ],
  );

  return <AlarmContext.Provider value={value}>{children}</AlarmContext.Provider>;
}

export function useAlarm() {
  const ctx = useContext(AlarmContext);
  if (!ctx) {
    throw new Error('useAlarm must be used within AlarmProvider');
  }
  return ctx;
}

function volumeForSoundKey(config: AlarmConfig | undefined, key: AlarmSoundKey): number {
  if (key === 'DRONE_GEOFENCE') {
    return config?.volumeDroneGeofence ?? config?.volumeAlert ?? 70;
  }
  if (key === 'DRONE_TELEMETRY') {
    return config?.volumeDroneTelemetry ?? config?.volumeNotice ?? 60;
  }
  return configToVolume(config, key as AlarmLevel) ?? 60;
}

function configToVolume(config: AlarmConfig | undefined, level: AlarmLevel): number | undefined {
  if (!config) return undefined;
  switch (level) {
    case 'INFO':
      return config.volumeInfo;
    case 'NOTICE':
      return config.volumeNotice;
    case 'ALERT':
      return config.volumeAlert;
    case 'CRITICAL':
      return config.volumeCritical;
    default:
      return undefined;
  }
}

function gapForLevel(config: AlarmConfig, level: AlarmLevel): number {
  switch (level) {
    case 'INFO':
      return config.gapInfoMs;
    case 'NOTICE':
      return config.gapNoticeMs;
    case 'ALERT':
      return config.gapAlertMs;
    case 'CRITICAL':
      return config.gapCriticalMs;
    default:
      return 0;
  }
}

function isWithinDndWindow(config: AlarmConfig, level: AlarmLevel): boolean {
  if (!config.dndStart || !config.dndEnd) {
    return false;
  }

  if (level === 'CRITICAL') {
    return false;
  }

  const start = parseTimeToMinutes(config.dndStart);
  const end = parseTimeToMinutes(config.dndEnd);
  if (start === null || end === null) {
    return false;
  }

  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  if (start === end) {
    return false;
  }

  if (start < end) {
    return minutes >= start && minutes < end;
  }

  return minutes >= start || minutes < end;
}

function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }
  return hours * 60 + minutes;
}
