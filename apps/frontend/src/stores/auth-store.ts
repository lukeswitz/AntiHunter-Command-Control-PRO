import { create } from 'zustand';

import { apiClient } from '../api/client';
import type { AuthUser, LoginResponse, MeResponse } from '../api/types';
import { getAuthToken, registerLogoutListener, storeAuthToken } from '../auth/session';

const DEFAULT_DISCLAIMER = `
By accessing and using the AntiHunter Command & Control Platform (the "Software") you acknowledge and agree to the following:

1. Authorized Use Only. You are granted access solely for authorized defensive, security, or testing operations that comply with all applicable laws and regulations.
2. Compliance Obligations. You are responsible for obtaining any approvals, consents, or licenses required to monitor or interact with the networks and devices under your control. Unauthorized monitoring or interference with third-party systems is prohibited.
3. Logging and Auditing. Your activities may be logged and audited. You consent to the capture and retention of operational and security telemetry for compliance purposes.
4. No Warranty. The Software is provided "as is" without warranties of any kind. You assume all risks arising from its deployment, including any unintended network or device impact.
5. Indemnification. You agree to indemnify and hold harmless the Software authors and operators against any claims or damages arising from your misuse or unauthorized actions.

By checking the acknowledgement box you certify that you have read, understood, and agree to abide by the terms above. If you do not agree, you must discontinue use immediately.
`.trim();

type AuthStatus = 'checking' | 'login' | 'legal' | 'authenticated';

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  token: string | null;
  pendingToken: string | null;
  disclaimer: string;
  isSubmitting: boolean;
  error?: string;
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  acceptLegal: () => Promise<void>;
  logout: () => void;
  clearError: () => void;
  setUser: (user: AuthUser) => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'checking',
  user: null,
  token: null,
  pendingToken: null,
  disclaimer: DEFAULT_DISCLAIMER,
  isSubmitting: false,
  async initialize() {
    const storedToken = getAuthToken();
    if (!storedToken) {
      set({ status: 'login', token: null, user: null, pendingToken: null });
      return;
    }
    set({ status: 'checking', token: storedToken, isSubmitting: true });
    try {
      const response = await apiClient.get<MeResponse>('/auth/me');
      const legalAccepted = response.legalAccepted ?? response.user.legalAccepted;
      if (!legalAccepted) {
        set({
          status: 'legal',
          user: response.user,
          pendingToken: storedToken,
          token: null,
          disclaimer: response.disclaimer ?? DEFAULT_DISCLAIMER,
          isSubmitting: false,
        });
        storeAuthToken(null);
        return;
      }
      set({
        status: 'authenticated',
        user: response.user,
        token: storedToken,
        pendingToken: null,
        disclaimer: DEFAULT_DISCLAIMER,
        isSubmitting: false,
      });
    } catch {
      storeAuthToken(null);
      set({
        status: 'login',
        user: null,
        token: null,
        pendingToken: null,
        isSubmitting: false,
      });
    }
  },
  async login(email, password) {
    set({ isSubmitting: true, error: undefined });
    try {
      const response = await apiClient.post<LoginResponse>(
        '/auth/login',
        { email, password },
        { skipAuth: true },
      );

      if (response.legalAccepted) {
        storeAuthToken(response.token);
        set({
          status: 'authenticated',
          token: response.token,
          user: response.user,
          pendingToken: null,
          disclaimer: DEFAULT_DISCLAIMER,
          isSubmitting: false,
        });
      } else {
        set({
          status: 'legal',
          user: response.user,
          pendingToken: response.token,
          token: null,
          disclaimer: response.disclaimer ?? DEFAULT_DISCLAIMER,
          isSubmitting: false,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to authenticate';
      set({ error: message, isSubmitting: false, status: 'login' });
    }
  },
  async acceptLegal() {
    const { pendingToken } = get();
    if (!pendingToken) {
      set({ error: 'Missing pending acknowledgement token' });
      return;
    }
    set({ isSubmitting: true, error: undefined });
    try {
      const response = await apiClient.post<LoginResponse>(
        '/auth/legal-ack',
        { accepted: true },
        { skipAuth: true, tokenOverride: pendingToken },
      );
      storeAuthToken(response.token);
      set({
        status: 'authenticated',
        user: response.user,
        token: response.token,
        pendingToken: null,
        disclaimer: DEFAULT_DISCLAIMER,
        isSubmitting: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to confirm acknowledgement';
      set({ error: message, isSubmitting: false });
    }
  },
  logout() {
    storeAuthToken(null);
    set({
      status: 'login',
      user: null,
      token: null,
      pendingToken: null,
      error: undefined,
      isSubmitting: false,
    });
  },
  clearError() {
    set({ error: undefined });
  },
  setUser(user) {
    set({ user });
  },
}));

registerLogoutListener(() => {
  useAuthStore.getState().logout();
});
