import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  MdMap,
  MdSensors,
  MdMyLocation,
  MdWifiTethering,
  MdTerminal,
  MdChat,
  MdSettings,
  MdDownload,
  MdEventNote,
  MdOutlineAreaChart,
  MdPerson,
  MdHub,
  MdExtension,
  MdNotificationsActive,
} from 'react-icons/md';
import { NavLink } from 'react-router-dom';

import {
  ALERTS_ADDON_EVENT,
  ALERTS_ADDON_STORAGE_KEY,
  CHAT_ADDON_EVENT,
  CHAT_ADDON_STORAGE_KEY,
  SCHEDULER_ADDON_EVENT,
  SCHEDULER_ADDON_STORAGE_KEY,
  STRATEGY_ADDON_EVENT,
  STRATEGY_ADDON_STORAGE_KEY,
  getAlertsAddonEnabled,
  getChatAddonEnabled,
  getSchedulerAddonEnabled,
  getStrategyAddonEnabled,
} from '../constants/addons';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  hideOnMobile?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/map', label: 'Map', icon: MdMap },
  { to: '/console', label: 'Console', icon: MdTerminal },
  { to: '/chat', label: 'Chat', icon: MdChat },
  { to: '/inventory', label: 'Inventory', icon: MdWifiTethering },
  { to: '/alerts', label: 'Alerts', icon: MdNotificationsActive },
  { to: '/targets', label: 'Targets', icon: MdMyLocation },
  { to: '/geofences', label: 'Geofences', icon: MdOutlineAreaChart },
  { to: '/nodes', label: 'Nodes', icon: MdSensors },
  { to: '/scheduler', label: 'Scheduler', icon: MdEventNote },
  { to: '/strategy', label: 'Strategy Advisor', icon: MdHub, hideOnMobile: true },
  { to: '/addon', label: 'Addon', icon: MdExtension },
  { to: '/config', label: 'Config', icon: MdSettings },
  { to: '/exports', label: 'Exports', icon: MdDownload },
  { to: '/account', label: 'Account', icon: MdPerson },
];

export function SidebarNav() {
  const [strategyEnabled, setStrategyEnabled] = useState<boolean>(() => getStrategyAddonEnabled());
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(() => getAlertsAddonEnabled());
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean>(() =>
    getSchedulerAddonEnabled(),
  );
  const [chatEnabled, setChatEnabled] = useState<boolean>(() => getChatAddonEnabled());

  useEffect(() => {
    const syncStrategy = () => setStrategyEnabled(getStrategyAddonEnabled());
    const syncAlerts = () => setAlertsEnabled(getAlertsAddonEnabled());
    const syncScheduler = () => setSchedulerEnabled(getSchedulerAddonEnabled());
    const syncChat = () => setChatEnabled(getChatAddonEnabled());

    const handleStorage = (event: StorageEvent) => {
      if (event.key === STRATEGY_ADDON_STORAGE_KEY) {
        syncStrategy();
      }
      if (event.key === ALERTS_ADDON_STORAGE_KEY) {
        syncAlerts();
      }
      if (event.key === SCHEDULER_ADDON_STORAGE_KEY) {
        syncScheduler();
      }
      if (event.key === CHAT_ADDON_STORAGE_KEY) {
        syncChat();
      }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(STRATEGY_ADDON_EVENT, syncStrategy);
    window.addEventListener(ALERTS_ADDON_EVENT, syncAlerts);
    window.addEventListener(SCHEDULER_ADDON_EVENT, syncScheduler);
    window.addEventListener(CHAT_ADDON_EVENT, syncChat);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(STRATEGY_ADDON_EVENT, syncStrategy);
      window.removeEventListener(ALERTS_ADDON_EVENT, syncAlerts);
      window.removeEventListener(SCHEDULER_ADDON_EVENT, syncScheduler);
      window.removeEventListener(CHAT_ADDON_EVENT, syncChat);
    };
  }, []);

  const navItems = useMemo(() => {
    return NAV_ITEMS.filter((item) => {
      if (item.to === '/strategy') {
        return strategyEnabled;
      }
      if (item.to === '/alerts') {
        return alertsEnabled;
      }
      if (item.to === '/scheduler') {
        return schedulerEnabled;
      }
      if (item.to === '/chat') {
        return chatEnabled;
      }
      return true;
    });
  }, [strategyEnabled, alertsEnabled, schedulerEnabled, chatEnabled]);

  return (
    <aside className="sidebar">
      {navItems.map(({ to, label, icon: Icon, hideOnMobile }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `nav-link ${isActive ? 'active' : ''}${hideOnMobile ? ' nav-link--mobile-hidden' : ''}`
          }
        >
          <Icon className="nav-icon" />
          <span className="nav-text">{label}</span>
        </NavLink>
      ))}
    </aside>
  );
}
