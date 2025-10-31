import { Link } from 'react-router-dom';
import { MdBrightness4, MdBrightness7, MdLogout, MdSignalWifiStatusbar4Bar } from 'react-icons/md';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useSocketConnected } from '../providers/socket-provider';
import { useTheme } from '../providers/theme-provider';
import { useAuthStore } from '../stores/auth-store';
import { apiClient } from '../api/client';
import type { AuthUser } from '../api/types';

export function AppHeader() {
  const isConnected = useSocketConnected();
  const { theme, setTheme } = useTheme();
  const user = useAuthStore((state) => state.user);
  const setAuthUser = useAuthStore((state) => state.setUser);
  const logout = useAuthStore((state) => state.logout);
  const status = useAuthStore((state) => state.status);
  const queryClient = useQueryClient();

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
  const isAdmin = authenticated && user?.role === 'ADMIN';

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <span className="app-header__brand-icon" aria-hidden="true">
          <img className="app-header__brand-mark" src="/header_logo.png" alt="AntiHunter Shield Logo" />
        </span>
        <div>
          <span className="brand-title">AntiHunter Command &amp; Control Pro</span>
          <span className="brand-subtitle">Public 0.9.0-beta.1</span>
        </div>
      </div>

      <div className="app-header__actions">
        <div className={`connection-indicator ${isConnected ? 'ok' : 'down'}`}>
          <MdSignalWifiStatusbar4Bar />
          {isConnected ? 'Connected' : 'Disconnected'}
        </div>
        {isAdmin ? (
          <Link to="/account" className="control-chip">
            Admin
          </Link>
        ) : null}
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
