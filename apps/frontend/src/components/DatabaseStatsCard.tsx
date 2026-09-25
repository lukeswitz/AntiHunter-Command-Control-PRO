import { useQuery } from '@tanstack/react-query';

import { apiClient } from '../api/client';

const LABELS: Record<string, string> = {
  nodes: 'Mesh nodes',
  nodePositions: 'Node positions',
  drones: 'Drones',
  targets: 'Targets',
  inventory: 'Inventory devices',
  alertRules: 'Alert rules',
  alertEvents: 'Alert events',
  commands: 'Command log',
  geofences: 'Geofences',
  webhooks: 'Webhooks',
  users: 'Users',
  auditLog: 'Audit log',
};

interface Props {
  className: string;
  isAdmin: boolean;
}

export function DatabaseStatsCard({ className, isAdmin }: Props) {
  const stats = useQuery({
    queryKey: ['database-stats'],
    queryFn: () => apiClient.get<Record<string, number>>('/config/app/database-stats'),
    enabled: isAdmin,
  });

  return (
    <section className={className}>
      <header>
        <h2>Database</h2>
        <p>Row counts for the stored operational data.</p>
      </header>
      <div className="config-card__body">
        {!isAdmin ? (
          <div className="form-error">Administrator privileges required.</div>
        ) : stats.isError ? (
          <p className="config-hint config-hint--warn">Could not load database stats.</p>
        ) : !stats.data ? (
          <p className="config-hint">Loading.</p>
        ) : (
          Object.entries(LABELS).map(([key, label]) => (
            <div className="config-row" key={key}>
              <span className="config-label">{label}</span>
              <span>{stats.data[key] ?? 0}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
