import { create } from 'zustand';

import { apiClient } from '../api/client';

export interface UpdateCheckResult {
  updateAvailable: boolean;
  localCommit: string;
  remoteCommit: string;
  commitsBehind: number;
  lastChecked: string;
}

export interface UpdateResult {
  success: boolean;
  message: string;
  previousCommit: string;
  newCommit: string;
  stashed: boolean;
  stashRestored: boolean;
}

type UpdateStatus = 'idle' | 'checking' | 'updating' | 'success' | 'error';

interface UpdateState {
  status: UpdateStatus;
  updateAvailable: boolean;
  localCommit: string | null;
  remoteCommit: string | null;
  commitsBehind: number;
  lastChecked: string | null;
  error: string | null;
  updateResult: UpdateResult | null;
  dismissed: boolean;
  checkForUpdate: () => Promise<void>;
  performUpdate: () => Promise<void>;
  dismiss: () => void;
  reset: () => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  updateAvailable: false,
  localCommit: null,
  remoteCommit: null,
  commitsBehind: 0,
  lastChecked: null,
  error: null,
  updateResult: null,
  dismissed: false,

  async checkForUpdate() {
    // Don't check if already checking/updating
    if (get().status === 'checking' || get().status === 'updating') {
      return;
    }

    set({ status: 'checking', error: null });

    try {
      const result = await apiClient.get<UpdateCheckResult>('/system/update/check');
      set({
        status: 'idle',
        updateAvailable: result.updateAvailable,
        localCommit: result.localCommit,
        remoteCommit: result.remoteCommit,
        commitsBehind: result.commitsBehind,
        lastChecked: result.lastChecked,
        dismissed: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check for updates';
      set({ status: 'error', error: message });
    }
  },

  async performUpdate() {
    if (get().status === 'updating') {
      return;
    }

    set({ status: 'updating', error: null, updateResult: null });

    try {
      const result = await apiClient.post<UpdateResult>('/system/update');
      set({
        status: 'success',
        updateResult: result,
        updateAvailable: false,
        localCommit: result.newCommit,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Update failed';
      set({ status: 'error', error: message });
    }
  },

  dismiss() {
    set({ dismissed: true });
  },

  reset() {
    set({
      status: 'idle',
      updateAvailable: false,
      localCommit: null,
      remoteCommit: null,
      commitsBehind: 0,
      lastChecked: null,
      error: null,
      updateResult: null,
      dismissed: false,
    });
  },
}));
