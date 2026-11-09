import { apiClient } from './client';

export interface KnownMeshRadio {
  mac: string;
  radio: string;
  name: string | null;
  addedBy: string | null;
  createdAt: string;
}

export interface MeshRadioSighting {
  mac: string;
  radio: string;
  name: string | null;
  rssi: number | null;
  nodeId: string | null;
  lastSeen: string;
  known: boolean;
}

export const getKnownRadios = () =>
  apiClient.get<{ known: KnownMeshRadio[]; recent: MeshRadioSighting[] }>('/nodes/known-radios');

export const addKnownRadio = (body: { mac: string; radio: string; name?: string }) =>
  apiClient.post<KnownMeshRadio>('/nodes/known-radios', body);

export const removeKnownRadio = (mac: string) =>
  apiClient.delete<{ ok: boolean }>(`/nodes/known-radios/${encodeURIComponent(mac)}`);

export const syncKnownRadios = () => apiClient.post<{ sent: number }>('/nodes/known-radios/sync');
