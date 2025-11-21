import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useMemo, useState } from 'react';
import { MdAdd, MdDelete, MdLink, MdRefresh } from 'react-icons/md';

import type { Webhook } from '../api/types';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  testWebhook,
  updateWebhook,
} from '../api/webhooks';
import { useAuthStore } from '../stores/auth-store';

type WebhookFormMode = 'create' | 'edit';

const WEBHOOK_EVENT_OPTIONS = [
  { value: 'ALERT_TRIGGERED', label: 'Alert triggered' },
  { value: 'INVENTORY_UPDATED', label: 'Inventory updated' },
  { value: 'NODE_TELEMETRY', label: 'Node telemetry' },
  { value: 'TARGET_DETECTED', label: 'Target detected' },
  { value: 'NODE_ALERT', label: 'Node alerts & status' },
  { value: 'HEARTBEAT', label: 'Node heartbeat' },
  { value: 'TRIANGULATION', label: 'Triangulation events' },
  { value: 'TIME_SYNC', label: 'Time sync events' },
  { value: 'DRONE_TELEMETRY', label: 'Drone telemetry' },
  { value: 'COMMAND_ACK', label: 'Command acknowledgements' },
  { value: 'COMMAND_RESULT', label: 'Command results' },
  { value: 'SERIAL_RAW', label: 'Raw serial lines' },
] as const;
const WEBHOOK_EVENT_LABELS = WEBHOOK_EVENT_OPTIONS.reduce<Record<string, string>>((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {});

interface WebhookFormState {
  id?: string;
  name: string;
  url: string;
  secret: string;
  enabled: boolean;
  shareWithEveryone: boolean;
  subscribedEvents: string[];
  verifyTls: boolean;
  clientCertificate: string;
  clientKey: string;
  caBundle: string;
}

const DEFAULT_FORM_STATE: WebhookFormState = {
  name: '',
  url: '',
  secret: '',
  enabled: true,
  shareWithEveryone: false,
  subscribedEvents: ['ALERT_TRIGGERED'],
  verifyTls: true,
  clientCertificate: '',
  clientKey: '',
  caBundle: '',
};

export function WebhooksSection() {
  const queryClient = useQueryClient();
  const role = useAuthStore((state) => state.user?.role ?? 'VIEWER');
  const [formMode, setFormMode] = useState<WebhookFormMode>('create');
  const [formState, setFormState] = useState<WebhookFormState>({ ...DEFAULT_FORM_STATE });

  const webhooksQuery = useQuery({
    queryKey: ['webhooks'],
    queryFn: listWebhooks,
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: createWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      setFormState({ ...DEFAULT_FORM_STATE });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<WebhookFormState> }) =>
      updateWebhook(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      setFormMode('create');
      setFormState({ ...DEFAULT_FORM_STATE });
    },
  });

  const testMutation = useMutation({
    mutationFn: testWebhook,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const selectedWebhook = useMemo(() => {
    if (!formState.id) {
      return null;
    }
    return webhooksQuery.data?.find((hook) => hook.id === formState.id) ?? null;
  }, [formState.id, webhooksQuery.data]);

  const handleSelect = (webhook: Webhook) => {
    setFormMode('edit');
    setFormState({
      id: webhook.id,
      name: webhook.name,
      url: webhook.url,
      secret: '',
      enabled: webhook.enabled,
      shareWithEveryone: webhook.shared,
      subscribedEvents: webhook.subscribedEvents.length
        ? webhook.subscribedEvents
        : ['ALERT_TRIGGERED'],
      verifyTls: webhook.verifyTls ?? true,
      clientCertificate: webhook.clientCertificate ?? '',
      clientKey: webhook.clientKey ?? '',
      caBundle: webhook.caBundle ?? '',
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (formMode === 'create') {
      createMutation.mutate({
        name: formState.name,
        url: formState.url,
        secret: formState.secret || undefined,
        enabled: formState.enabled,
        shareWithEveryone: formState.shareWithEveryone,
        subscribedEvents: formState.subscribedEvents,
        verifyTls: formState.verifyTls,
        clientCertificate: formState.clientCertificate,
        clientKey: formState.clientKey,
        caBundle: formState.caBundle,
      });
    } else if (formState.id) {
      updateMutation.mutate({
        id: formState.id,
        payload: {
          name: formState.name,
          url: formState.url,
          secret: formState.secret || undefined,
          enabled: formState.enabled,
          shareWithEveryone: formState.shareWithEveryone,
          subscribedEvents: formState.subscribedEvents,
          verifyTls: formState.verifyTls,
          clientCertificate: formState.clientCertificate,
          clientKey: formState.clientKey,
          caBundle: formState.caBundle,
        },
      });
    }
  };

  const handleReset = () => {
    setFormMode('create');
    setFormState({ ...DEFAULT_FORM_STATE });
  };

  const formatEvents = (events: string[]) =>
    events.length === 0
      ? 'None selected'
      : events.map((value) => WEBHOOK_EVENT_LABELS[value] ?? value).join(', ');

  const handleToggleEvent = (eventValue: string) => {
    setFormState((prev) => {
      if (prev.subscribedEvents.includes(eventValue)) {
        return {
          ...prev,
          subscribedEvents:
            prev.subscribedEvents.length === 1
              ? prev.subscribedEvents
              : prev.subscribedEvents.filter((value) => value !== eventValue),
        };
      }
      return { ...prev, subscribedEvents: [...prev.subscribedEvents, eventValue] };
    });
  };

  const handleDelete = () => {
    if (formState.id) {
      deleteMutation.mutate(formState.id);
    }
  };

  const handleTest = (id: string) => {
    testMutation.mutate(id);
  };

  return (
    <div className="config-grid webhooks-stack">
      <article className="config-card">
        <header>
          <h3>Registered webhooks</h3>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['webhooks'] })}
          >
            <MdRefresh /> Refresh
          </button>
        </header>
        <div className="config-card__body">
          {webhooksQuery.isLoading ? (
            <p className="empty-state">Loading webhooks...</p>
          ) : webhooksQuery.data && webhooksQuery.data.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Events</th>
                    <th>Linked rules</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooksQuery.data.map((webhook) => (
                    <tr key={webhook.id}>
                      <td>{webhook.name}</td>
                      <td>{webhook.url}</td>
                      <td>{webhook.enabled ? 'Enabled' : 'Disabled'}</td>
                      <td className="webhook-events-cell">
                        {formatEvents(webhook.subscribedEvents)}
                      </td>
                      <td>{webhook.linkedRuleIds.length}</td>
                      <td className="table-actions">
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => handleSelect(webhook)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="control-chip control-chip--ghost"
                          onClick={() => handleTest(webhook.id)}
                          disabled={testMutation.isPending}
                        >
                          <MdLink /> Test
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">
              No webhooks configured yet. Use the form on the right to create one.
            </p>
          )}
        </div>
      </article>

      <article className="config-card">
        <header>
          <h3>{formMode === 'create' ? 'Create webhook' : `Edit ${formState.name}`}</h3>
          <p>Define HTTPS callback URLs to notify when alerts trigger.</p>
        </header>
        <form className="config-card__body" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              <span>Name</span>
              <input
                className="control-input"
                type="text"
                value={formState.name}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, name: event.target.value }))
                }
                required
              />
            </label>
            <label>
              <span>Destination URL</span>
              <input
                className="control-input"
                type="url"
                value={formState.url}
                onChange={(event) => setFormState((prev) => ({ ...prev, url: event.target.value }))}
                required
                placeholder="https://example.com/webhooks/alert"
              />
            </label>
          </div>
          <label className="form-field">
            <span>Secret (optional)</span>
            <input
              className="control-input"
              type="text"
              value={formState.secret}
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, secret: event.target.value }))
              }
              placeholder="Used to sign webhook payloads"
            />
          </label>
          <div className="toggle-row">
            <label className="control-checkbox">
              <input
                type="checkbox"
                checked={formState.enabled}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, enabled: event.target.checked }))
                }
              />
              <span>Enabled</span>
            </label>
            {role === 'ADMIN' && (
              <label className="control-checkbox">
                <input
                  type="checkbox"
                  checked={formState.shareWithEveryone}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, shareWithEveryone: event.target.checked }))
                  }
                />
                <span>Shared with all operators</span>
              </label>
            )}
          </div>
          <div className="webhook-security">
            <h4>HTTPS security</h4>
            <label className="control-checkbox">
              <input
                type="checkbox"
                checked={formState.verifyTls}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, verifyTls: event.target.checked }))
                }
              />
              <span>Verify server certificates</span>
            </label>
            <p className="config-hint">
              Disable only for trusted lab environments or self-signed test endpoints.
            </p>
            <div className="webhook-tls-grid">
              <label className="form-field">
                <span>Client certificate (PEM)</span>
                <textarea
                  className="control-input"
                  rows={4}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  value={formState.clientCertificate}
                  onChange={(event) =>
                    setFormState((prev) => ({
                      ...prev,
                      clientCertificate: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>Client private key (PEM)</span>
                <textarea
                  className="control-input"
                  rows={4}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  value={formState.clientKey}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, clientKey: event.target.value }))
                  }
                />
              </label>
              <label className="form-field">
                <span>Custom CA bundle (optional)</span>
                <textarea
                  className="control-input"
                  rows={4}
                  placeholder="Paste trusted root/intermediate certificates"
                  value={formState.caBundle}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, caBundle: event.target.value }))
                  }
                />
              </label>
            </div>
            <p className="config-hint">
              Leave certificate fields empty to use the system trust store without mutual TLS.
            </p>
          </div>
          <div className="webhook-event-picker">
            <span>Deliver these events</span>
            <div className="webhook-event-picker__list">
              {WEBHOOK_EVENT_OPTIONS.map((option) => (
                <label key={option.value} className="control-checkbox">
                  <input
                    type="checkbox"
                    checked={formState.subscribedEvents.includes(option.value)}
                    onChange={() => handleToggleEvent(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
          <div className="controls-row">
            <button
              type="submit"
              className="control-chip"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {formMode === 'create' ? (
                <>
                  <MdAdd /> Create
                </>
              ) : (
                'Save changes'
              )}
            </button>
            <button
              type="button"
              className="control-chip control-chip--ghost"
              onClick={handleReset}
            >
              Reset
            </button>
            {formMode === 'edit' && (
              <button
                type="button"
                className="control-chip control-chip--danger"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                <MdDelete /> Delete
              </button>
            )}
          </div>
        </form>
      </article>

      {selectedWebhook && (
        <article className="config-card">
          <header>
            <h3>Recent deliveries</h3>
            <p>Latest attempts for {selectedWebhook.name}.</p>
          </header>
          <div className="config-card__body">
            {selectedWebhook.recentDeliveries.length === 0 ? (
              <p className="empty-state">No deliveries yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Status</th>
                      <th>Code</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedWebhook.recentDeliveries.map((delivery) => (
                      <tr key={delivery.id}>
                        <td>{new Date(delivery.triggeredAt).toLocaleString()}</td>
                        <td>{delivery.success ? 'Success' : 'Failed'}</td>
                        <td>{delivery.statusCode ?? '---'}</td>
                        <td>{delivery.errorMessage ?? '---'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </article>
      )}
    </div>
  );
}
