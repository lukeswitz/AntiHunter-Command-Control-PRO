import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { MdBrightness4, MdBrightness7, MdLogout, MdSignalWifiStatusbar4Bar } from 'react-icons/md';

import { apiClient } from '../api/client';
import type { AuthUser } from '../api/types';
import { useSocketConnected } from '../providers/socket-provider';
import { useTheme } from '../providers/theme-provider';
import { useAuthStore } from '../stores/auth-store';
import { useTriangulationStore } from '../stores/triangulation-store';
import { useTrackingBannerStore } from '../stores/tracking-banner-store';

export function AppHeader() {
  const isConnected = useSocketConnected();
  const { theme, setTheme } = useTheme();
  const user = useAuthStore((state) => state.user);
  const setAuthUser = useAuthStore((state) => state.setUser);
  const logout = useAuthStore((state) => state.logout);
  const status = useAuthStore((state) => state.status);
  const queryClient = useQueryClient();
  const triangulation = useTriangulationStore((state) => state);
  const trackingBanner = useTrackingBannerStore((state) => state);
  const [clock, setClock] = useState(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const updateThemeMutation = useMutation<
    AuthUser,
    Error,
    'light' | 'dark',
    { previousTheme: 'light' | 'dark' } | undefined
  >({
    mutationFn: (nextTheme: 'light' | 'dark') =>
      apiClient.put<AuthUser>('/users/me', {
        theme: nextTheme,
      }),
    onMutate: async (nextTheme) => {
      const previousTheme = theme;
      setTheme(nextTheme);
      return { previousTheme };
    },
    onSuccess: (data, nextTheme) => {
      setAuthUser(data);
      queryClient.setQueryData(['users', 'me'], data);
      setTheme(nextTheme);
    },
    onError: (_error, _nextTheme, context) => {
      if (context && context.previousTheme) {
        setTheme(context.previousTheme);
      }
    },
  });

  const handleToggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';

    if (updateThemeMutation.isPending || !user) {
      setTheme(nextTheme);
      return;
    }

    updateThemeMutation.mutate(nextTheme);
  };

  const authenticated = status === 'authenticated' && user;

  let bannerText: string | null = null;
  let bannerCountdown: string | null = null;

  const triExpired =
    triangulation.lastUpdated != null &&
    (triangulation.status === 'processing' ||
      triangulation.status === 'success' ||
      triangulation.status === 'failed') &&
    clock - triangulation.lastUpdated > 20000;

  const trackingExpired =
    trackingBanner.lastUpdated != null &&
    (trackingBanner.status === 'success' || trackingBanner.status === 'failed') &&
    clock - trackingBanner.lastUpdated > 20000;

  if (
    trackingBanner.status === 'running' &&
    trackingBanner.endsAt &&
    trackingBanner.targetMac &&
    !trackingExpired
  ) {
    const remainingMs = Math.max(0, trackingBanner.endsAt - clock);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(remainingSec / 60)
      .toString()
      .padStart(2, '0');
    const seconds = (remainingSec % 60).toString().padStart(2, '0');
    bannerText = 'Tracking in progress';
    bannerCountdown = `${minutes}:${seconds}`;
  } else if (trackingBanner.status === 'success' && !trackingExpired) {
    bannerText = 'Tracking completed';
  } else if (trackingBanner.status === 'failed' && !trackingExpired) {
    bannerText = 'Tracking failed';
  } else if (!triExpired) {
    if (triangulation.status === 'running' && triangulation.endsAt) {
      const remainingMs = Math.max(0, triangulation.endsAt - clock);
      const remainingSec = Math.ceil(remainingMs / 1000);
      const minutes = Math.floor(remainingSec / 60)
        .toString()
        .padStart(2, '0');
      const seconds = (remainingSec % 60).toString().padStart(2, '0');
      bannerText = 'Triangulation in progress';
      bannerCountdown = `${minutes}:${seconds}`;
    } else if (triangulation.status === 'processing') {
      bannerText = 'Triangulation processing…';
    } else if (triangulation.status === 'failed') {
      bannerText = 'Triangulation failed';
    } else if (triangulation.status === 'success') {
      bannerText = 'Triangulation succeeded';
    }
  }

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__brand-icon" aria-hidden="true">
          <img
            className="app-header__brand-mark"
            src="/header_logo.png"
            alt="AntiHunter Shield Logo"
          />
        </span>
        <div>
          <span className="brand-title">AntiHunter Command &amp; Control Pro</span>
          <span className="brand-subtitle">Public 0.9.1-beta.1</span>
        </div>
      </div>

      {bannerText ? (
        <div className="app-header__triangulation">
          <div className="app-header__triangulation-label">{bannerText}</div>
          {bannerCountdown ? (
            <div className="app-header__triangulation-countdown">{bannerCountdown}</div>
          ) : null}
        </div>
      ) : null}

      <div className="app-header__actions">
        <div className={`connection-indicator ${isConnected ? 'ok' : 'down'}`}>
          <MdSignalWifiStatusbar4Bar />
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>
        {authenticated ? (
          <div className="user-pill" title={`Signed in as ${user.email}`}>
            <span className="user-pill__label">{user.email}</span>
            <span className="user-pill__role">{user.role}</span>
            <button type="button" onClick={logout} className="icon-button" aria-label="Sign out">
              <MdLogout />
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="icon-button"
          onClick={handleToggleTheme}
          aria-label="Toggle theme"
          disabled={updateThemeMutation.isPending}
        >
          {theme === 'light' ? <MdBrightness4 /> : <MdBrightness7 />}
        </button>
      </div>
    </header>
  );
}
