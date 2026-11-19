function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function fleetCoordinationText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const type = str(d.coordinationType).toUpperCase();
  if (type === 'FLEET_CMD') {
    const relayer = str(d.relayer);
    const target = str(d.target);
    const command = str(d.command);
    if (!relayer || !target || !command) return null;
    const origin = str(d.origin);
    const hop = typeof d.hops === 'number' && Number.isFinite(d.hops) ? d.hops : null;
    const from = origin ? ` from ${origin}` : '';
    const hopText = hop !== null ? ` (hop ${hop})` : '';
    return `${relayer} relayed @${target} ${command}${from}${hopText}`;
  }
  if (type === 'FLEET_WHAT') {
    const sender = str(d.sender);
    const target = str(d.target);
    const prefix = str(d.replyPrefix);
    if (!target || !prefix) return null;
    return `${sender || 'A node'} missed a command and asked ${target} for it (${prefix})`;
  }
  return null;
}
