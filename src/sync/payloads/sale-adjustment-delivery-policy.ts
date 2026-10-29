export class SaleAdjustmentDeliveryPolicy {
  static forMode(
    mode: string,
    integrationVerified: boolean,
  ): Record<string, unknown> {
    if (!['standalone', 'server_sync'].includes(mode))
      throw new Error('Modo inválido.');
    if (mode === 'server_sync' && !integrationVerified)
      throw new Error('Disponible al completar sesiones 7–10.');
    return {
      delivery_status: mode === 'standalone' ? 'not_required' : 'pending',
      persist_refs: mode === 'server_sync',
    };
  }
  static resolveBase(
    baseEventId: string,
    dependencies: string[],
    events: Record<string, { status: string; server_sequence?: number | null }>,
  ): Record<string, unknown> {
    let waiting = false;
    for (const id of new Set([...dependencies, baseEventId])) {
      const e = events[id];
      if (e && ['conflict', 'rejected', 'not_required'].includes(e.status))
        return { status: 'incident', base_server_sequence: null };
      if (!e || e.status === 'pending') {
        waiting = true;
        continue;
      }
      if (
        e.status !== 'accepted' ||
        !Number.isSafeInteger(e.server_sequence) ||
        e.server_sequence! <= 0
      )
        throw new Error('Dependencia oficial inválida.');
    }
    return waiting
      ? { status: 'pending', base_server_sequence: null }
      : {
          status: 'ready',
          base_server_sequence: events[baseEventId].server_sequence,
        };
  }
}
