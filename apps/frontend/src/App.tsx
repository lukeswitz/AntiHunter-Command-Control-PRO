import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { apiClient } from './api/client';
import type { AppSettings } from './api/types';
import { AppHeader } from './components/app-header';
import { AuthOverlay } from './components/auth-overlay';
import { SidebarNav } from './components/sidebar-nav';
import { SocketBridge } from './components/socket-bridge';
import { TerminalDrawer } from './components/terminal-drawer';
import { DEFAULT_ALERT_COLORS, extractAlertColors } from './constants/alert-colors';
import { CommandConsolePage } from './pages/CommandConsolePage';
import { ConfigPage } from './pages/ConfigPage';
import { ExportsPage } from './pages/ExportsPage';
import { GeofencePage } from './pages/GeofencePage';
import { InventoryPage } from './pages/InventoryPage';
import { MapPage } from './pages/MapPage';
import { NodesPage } from './pages/NodesPage';
import { SchedulerPage } from './pages/SchedulerPage';
import { TargetsPage } from './pages/TargetsPage';
import { UserPage } from './pages/UserPage';
import { useTheme } from './providers/theme-provider';
import { useAuthStore } from './stores/auth-store';

export default function App() {
  const status = useAuthStore((state) => state.status);
  const isAuthenticated = status === 'authenticated';
  const user = useAuthStore((state) => state.user);
  const { setTheme } = useTheme();

  const appSettingsQuery = useQuery({
    queryKey: ['appSettings'],
    queryFn: () => apiClient.get<AppSettings>('/config/app'),
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const preference = user?.preferences.theme;
    if (!preference) {
      return;
    }
    if (preference === 'dark' || preference === 'light') {
      setTheme(preference);
    } else if (typeof window !== 'undefined') {
      const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      setTheme(prefersDark ? 'dark' : 'light');
    }
  }, [user?.preferences.theme, setTheme]);

  useEffect(() => {
    if (isAuthenticated && appSettingsQuery.data) {
      applyAlertColors(extractAlertColors(appSettingsQuery.data));
    } else if (!isAuthenticated) {
      applyAlertColors(DEFAULT_ALERT_COLORS);
    }
  }, [isAuthenticated, appSettingsQuery.data]);

  return (
    <BrowserRouter>
      <SocketBridge />
      <div className={`app-shell ${isAuthenticated ? '' : 'is-blurred'}`}>
        <AppHeader />
        <div className="app-content">
          <SidebarNav />
          <main className="app-main">
            <Routes>
              <Route path="/" element={<Navigate to="/map" replace />} />
              <Route path="/map" element={<MapPage />} />
              <Route path="/geofences" element={<GeofencePage />} />
              <Route path="/nodes" element={<NodesPage />} />
              <Route path="/targets" element={<TargetsPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/console" element={<CommandConsolePage />} />
              <Route path="/config" element={<ConfigPage />} />
              <Route path="/exports" element={<ExportsPage />} />
              <Route path="/scheduler" element={<SchedulerPage />} />
              <Route path="/account" element={<UserPage />} />
              <Route path="*" element={<Navigate to="/map" replace />} />
            </Routes>
          </main>
          <TerminalDrawer />
        </div>
      </div>
      <AuthOverlay />
    </BrowserRouter>
  );
}

function applyAlertColors(config: typeof DEFAULT_ALERT_COLORS) {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  root.style.setProperty('--alert-color-idle', config.idle);
  root.style.setProperty('--alert-color-info', config.info);
  root.style.setProperty('--alert-color-notice', config.notice);
  root.style.setProperty('--alert-color-alert', config.alert);
  root.style.setProperty('--alert-color-critical', config.critical);
}
