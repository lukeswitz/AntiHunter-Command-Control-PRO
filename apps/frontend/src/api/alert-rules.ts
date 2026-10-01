import { apiClient } from './client';
import type { AlertRule, AlertRuleEvent, AlertRulePayload, AlertRuleScope } from './types';

export interface ListAlertRulesParams {
  search?: string;
  scope?: AlertRuleScope;
  includeInactive?: boolean;
  includeAll?: boolean;
}

function buildQuery(params: ListAlertRulesParams = {}): string {
  const query = new URLSearchParams();
  if (params.search) {
    query.set('search', params.search);
  }
  if (params.scope) {
    query.set('scope', params.scope);
  }
  if (params.includeInactive) {
    query.set('includeInactive', 'true');
  }
  if (params.includeAll) {
    query.set('includeAll', 'true');
  }
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

export function listAlertRules(params: ListAlertRulesParams = {}) {
  const query = buildQuery(params);
  return apiClient.get<AlertRule[]>(`/alert-rules${query}`);
}

export function createAlertRule(payload: AlertRulePayload) {
  return apiClient.post<AlertRule, AlertRulePayload>('/alert-rules', payload);
}

export function updateAlertRule(id: string, payload: Partial<AlertRulePayload>) {
  return apiClient.patch<AlertRule, Partial<AlertRulePayload>>(`/alert-rules/${id}`, payload);
}

export function deleteAlertRule(id: string) {
  return apiClient.delete<{ deleted: boolean }>(`/alert-rules/${id}`);
}

export interface ListAlertRuleEventsParams {
  ruleId?: string;
  limit?: number;
}

export function listAlertRuleEvents(params: ListAlertRuleEventsParams = {}) {
  const query = new URLSearchParams();
  if (params.ruleId) {
    query.set('ruleId', params.ruleId);
  }
  if (typeof params.limit === 'number') {
    query.set('limit', String(params.limit));
  }
  const qs = query.toString();
  return apiClient.get<AlertRuleEvent[]>(`/alert-rules/events${qs ? `?${qs}` : ''}`);
}

export function clearAlertRuleEvents(ruleId?: string) {
  const qs = ruleId ? `?${new URLSearchParams({ ruleId }).toString()}` : '';
  return apiClient.delete<{ deleted: number }>(`/alert-rules/events${qs}`);
}
