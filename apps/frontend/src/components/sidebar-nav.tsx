import type { ComponentType } from 'react';
import {
  MdMap,
  MdSensors,
  MdMyLocation,
  MdWifiTethering,
  MdTerminal,
  MdSettings,
  MdDownload,
  MdEventNote,
  MdOutlineAreaChart,
  MdPerson,
  MdHub,
  MdExtension,
} from 'react-icons/md';
import { NavLink } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  hideOnMobile?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/map', label: 'Map', icon: MdMap },
  { to: '/console', label: 'Console', icon: MdTerminal },
  { to: '/inventory', label: 'Inventory', icon: MdWifiTethering },
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
  return (
    <aside className="sidebar">
      {NAV_ITEMS.map(({ to, label, icon: Icon, hideOnMobile }) => (
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
