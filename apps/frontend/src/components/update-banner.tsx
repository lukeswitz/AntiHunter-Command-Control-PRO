import { useEffect, useState } from 'react';
import { MdClose, MdDownload, MdRefresh } from 'react-icons/md';

import { useAuthStore } from '../stores/auth-store';
import { useUpdateStore } from '../stores/update-store';

export function UpdateBanner() {
  const authStatus = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const {
    status,
    updateAvailable,
    commitsBehind,
    remoteCommit,
    error,
    updateResult,
    dismissed,
    checkForUpdate,
    performUpdate,
    dismiss,
  } = useUpdateStore();

  const [showConfirm, setShowConfirm] = useState(false);

  // Check for updates when user logs in (only for admins)
  useEffect(() => {
    if (authStatus === 'authenticated' && user?.role === 'ADMIN') {
      checkForUpdate();
    }
  }, [authStatus, user?.role, checkForUpdate]);

  // Don't show if not authenticated or not admin
  if (authStatus !== 'authenticated' || user?.role !== 'ADMIN') {
    return null;
  }

  // Don't show if dismissed and no active update
  if (dismissed && status !== 'updating' && status !== 'success') {
    return null;
  }

  // Show success message after update
  if (status === 'success' && updateResult) {
    return (
      <div className="update-banner update-banner--success">
        <span className="update-banner__text">
          Updated to {updateResult.newCommit}. {updateResult.message}
        </span>
        <button
          type="button"
          className="update-banner__action"
          onClick={() => window.location.reload()}
        >
          <MdRefresh /> Reload App
        </button>
        <button
          type="button"
          className="update-banner__dismiss"
          onClick={dismiss}
          aria-label="Dismiss"
        >
          <MdClose />
        </button>
      </div>
    );
  }

  // Show error message
  if (status === 'error' && error) {
    return (
      <div className="update-banner update-banner--error">
        <span className="update-banner__text">Update error: {error}</span>
        <button type="button" className="update-banner__action" onClick={checkForUpdate}>
          <MdRefresh /> Retry
        </button>
        <button
          type="button"
          className="update-banner__dismiss"
          onClick={dismiss}
          aria-label="Dismiss"
        >
          <MdClose />
        </button>
      </div>
    );
  }

  // Show updating state
  if (status === 'updating') {
    return (
      <div className="update-banner update-banner--updating">
        <span className="update-banner__text">Updating... Please wait.</span>
      </div>
    );
  }

  // Show confirmation dialog
  if (showConfirm) {
    return (
      <div className="update-banner update-banner--confirm">
        <span className="update-banner__text">
          Update to {remoteCommit}? Local changes will be stashed automatically.
        </span>
        <button
          type="button"
          className="update-banner__action update-banner__action--confirm"
          onClick={() => {
            setShowConfirm(false);
            performUpdate();
          }}
        >
          Yes, Update
        </button>
        <button
          type="button"
          className="update-banner__action update-banner__action--cancel"
          onClick={() => setShowConfirm(false)}
        >
          Cancel
        </button>
      </div>
    );
  }

  // Show update available
  if (updateAvailable) {
    return (
      <div className="update-banner">
        <span className="update-banner__text">
          Update available ({commitsBehind} commit{commitsBehind !== 1 ? 's' : ''} behind)
        </span>
        <button
          type="button"
          className="update-banner__action"
          onClick={() => setShowConfirm(true)}
        >
          <MdDownload /> Update Now
        </button>
        <button
          type="button"
          className="update-banner__dismiss"
          onClick={dismiss}
          aria-label="Dismiss"
        >
          <MdClose />
        </button>
      </div>
    );
  }

  // Nothing to show
  return null;
}
