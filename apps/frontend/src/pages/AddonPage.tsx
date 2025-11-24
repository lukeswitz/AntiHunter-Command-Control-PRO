import { useEffect, useState } from 'react';
import { MdChat, MdEventNote, MdHub, MdNotificationsActive } from 'react-icons/md';

import { apiClient } from '../api/client';
import type { AuthUser } from '../api/types';
import { useAuthStore } from '../stores/auth-store';

export function AddonPage() {
  const authUser = useAuthStore((state) => state.user);
  const setAuthUser = useAuthStore((state) => state.setUser);
  const addonPrefs = authUser?.preferences?.notifications?.addons ?? {};
  const [strategyEnabled, setStrategyEnabled] = useState<boolean>(addonPrefs.strategy ?? false);
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(addonPrefs.alerts ?? false);
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean>(addonPrefs.scheduler ?? false);
  const [chatEnabled, setChatEnabled] = useState<boolean>(addonPrefs.chat ?? false);

  useEffect(() => {
    setStrategyEnabled(addonPrefs.strategy ?? false);
    setAlertsEnabled(addonPrefs.alerts ?? false);
    setSchedulerEnabled(addonPrefs.scheduler ?? false);
    setChatEnabled(addonPrefs.chat ?? false);
  }, [addonPrefs.alerts, addonPrefs.chat, addonPrefs.scheduler, addonPrefs.strategy]);

  const updateAddons = async (next: Partial<Record<string, boolean>>) => {
    const merged = { ...addonPrefs, ...next };
    try {
      const updated = await apiClient.put<AuthUser>('/users/me', { addons: merged });
      setAuthUser(updated);
      setStrategyEnabled(updated.preferences?.notifications?.addons?.strategy ?? false);
      setAlertsEnabled(updated.preferences?.notifications?.addons?.alerts ?? false);
      setSchedulerEnabled(updated.preferences?.notifications?.addons?.scheduler ?? false);
      setChatEnabled(updated.preferences?.notifications?.addons?.chat ?? false);
    } catch (error) {
      console.error('Failed to update add-ons', error);
    }
  };

  const handleStrategyToggle = () => updateAddons({ strategy: !strategyEnabled });
  const handleAlertsToggle = () => updateAddons({ alerts: !alertsEnabled });
  const handleSchedulerToggle = () => updateAddons({ scheduler: !schedulerEnabled });
  const handleChatToggle = () => updateAddons({ chat: !chatEnabled });

  return (
    <div className="page addon-page">
      <header className="page-header">
        <h1>Add-ons</h1>
        <p className="form-hint">Extend Command Center with experimental capabilities.</p>
      </header>
      <div className="addon-grid">
        <article className="config-card addon-card">
          <div className="addon-card__logo">
            <MdHub size={42} />
          </div>
          <h2>Strategy Advisor</h2>
          <p>Generate high-level coverage plans and mission overlays using current target data.</p>
          <div className="addon-card__notice">This addon is under active development.</div>
          <p className="form-hint">
            Activating this feature reveals the Strategy Advisor entry in the main navigation.
          </p>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleStrategyToggle}>
              {strategyEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>

        <article className="config-card addon-card">
          <div className="addon-card__logo addon-card__logo--alerts">
            <MdNotificationsActive size={42} />
          </div>
          <h2>Alerts</h2>
          <p>Manage alert rules, routing, and webhook notifications for target detections.</p>
          <p className="form-hint">
            Toggle this add-on if you want to temporarily hide alert tooling from the interface.
          </p>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleAlertsToggle}>
              {alertsEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>

        <article className="config-card addon-card">
          <div className="addon-card__logo addon-card__logo--scheduler">
            <MdEventNote size={42} />
          </div>
          <h2>Scheduler</h2>
          <p>Plan commands days in advance and automatically dispatch sequences based on time.</p>
          <p className="form-hint">
            Enable the scheduler when you need recurring tasks; disable it to keep the interface
            lightweight.
          </p>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleSchedulerToggle}>
              {schedulerEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>

        <article className="config-card addon-card">
          <div className="addon-card__logo">
            <MdChat size={42} />
          </div>
          <h2>Operator Chat</h2>
          <p>Secure, encrypted operator chat over MQTT between sites.</p>
          <p className="form-hint">
            Toggle to show/hide chat in the navigation. Keys are managed in Config &rarr; Chat.
          </p>
          <div className="addon-card__actions">
            <button type="button" className="control-chip" onClick={handleChatToggle}>
              {chatEnabled ? 'Deactivate add-on' : 'Activate add-on'}
            </button>
          </div>
        </article>
      </div>
    </div>
  );
}
