import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  addKnownRadio,
  getKnownRadios,
  MeshRadioSighting,
  removeKnownRadio,
  syncKnownRadios,
} from '../api/known-radios';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function MeshRadiosCard({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['known-radios'],
    queryFn: getKnownRadios,
    refetchInterval: 15_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['known-radios'] });
  const fail = (error: unknown) => setNotice(errorText(error));

  const addMutation = useMutation({
    mutationFn: (s: MeshRadioSighting) =>
      addKnownRadio({ mac: s.mac, radio: s.radio, name: s.name ?? undefined }),
    onSuccess: (row) => {
      setNotice(`${row.name ?? row.mac} is known. Sent to all nodes.`);
      refresh();
    },
    onError: fail,
  });
  const removeMutation = useMutation({
    mutationFn: removeKnownRadio,
    onSuccess: () => {
      setNotice('Removed. Sent to all nodes.');
      refresh();
    },
    onError: fail,
  });
  const syncMutation = useMutation({
    mutationFn: syncKnownRadios,
    onSuccess: (res) => setNotice(`Sent ${res.sent} known radios to all nodes.`),
    onError: fail,
  });
  const busy = addMutation.isPending || removeMutation.isPending || syncMutation.isPending;

  const known = query.data?.known ?? [];
  const unknown = (query.data?.recent ?? []).filter((s) => !s.known);

  return (
    <div className="panel__section">
      <h2 className="panel__section-title">Mesh radios</h2>
      <p className="panel__subtitle">
        Meshtastic and MeshCore radios your nodes detected. Mark your own radios as known and the
        nodes stop alerting on them.
      </p>

      <div className="nodes-table">
        <table>
          <thead>
            <tr>
              <th>Detected radio</th>
              <th>MAC</th>
              <th>Seen by</th>
              <th>RSSI</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {unknown.length === 0 ? (
              <tr>
                <td colSpan={6}>No unknown radios detected.</td>
              </tr>
            ) : (
              unknown.map((s) => (
                <tr key={s.mac}>
                  <td>
                    {s.name ?? 'Unnamed'} ({s.radio})
                  </td>
                  <td>{s.mac}</td>
                  <td>{s.nodeId ?? '-'}</td>
                  <td>{s.rssi ?? '-'}</td>
                  <td>{new Date(s.lastSeen).toLocaleString()}</td>
                  <td>
                    <button
                      type="button"
                      className="control-chip"
                      disabled={!canEdit || busy}
                      onClick={() => addMutation.mutate(s)}
                    >
                      Mark known
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="nodes-table">
        <table>
          <thead>
            <tr>
              <th>Known radio</th>
              <th>MAC</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {known.length === 0 ? (
              <tr>
                <td colSpan={4}>No known radios.</td>
              </tr>
            ) : (
              known.map((k) => (
                <tr key={k.mac}>
                  <td>
                    {k.name ?? 'Unnamed'} ({k.radio})
                  </td>
                  <td>{k.mac}</td>
                  <td>{new Date(k.createdAt).toLocaleString()}</td>
                  <td>
                    <button
                      type="button"
                      className="control-chip control-chip--danger"
                      disabled={!canEdit || busy}
                      onClick={() => removeMutation.mutate(k.mac)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="controls-row">
        <button
          type="button"
          className="control-chip"
          disabled={!canEdit || busy || known.length === 0}
          onClick={() => syncMutation.mutate()}
          title="Use after adding a node to the mesh"
        >
          Send list to all nodes
        </button>
      </div>
      {notice && <p className="panel__subtitle">{notice}</p>}
      {query.error && <p className="panel__subtitle">{errorText(query.error)}</p>}
    </div>
  );
}
