import { requiredRecord, requiredUuidV4 } from './inventory-movement.payload';
/** Asociación explícita y causal de una operación cash a una apertura. */
export class CashBindingPayload {
  private constructor(readonly sessionId: string, readonly openingEventId: string, readonly movementId: string) {}
  static optional(value: unknown, method: string, amount: number): CashBindingPayload | null {
    if (value == null) return null; // Compatibilidad histórica explícita.
    if (method !== 'cash' || amount <= 0) throw new Error('Solo efectivo aplicado positivo puede afectar la caja.');
    const p = requiredRecord(value, 'cash');
    return new CashBindingPayload(requiredUuidV4(p.session_id, 'session_id'), requiredUuidV4(p.opening_event_id, 'opening_event_id'), requiredUuidV4(p.movement_id, 'movement_id'));
  }
  toJson(): Record<string, unknown> { return {session_id: this.sessionId, opening_event_id: this.openingEventId, movement_id: this.movementId}; }
}
