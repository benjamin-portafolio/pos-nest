import { requiredUuidV4 } from './inventory-movement.payload';
import { integer } from './venta-confirmada.payload';
export class CajaAbiertaPayload {
  static readonly aggregateType = 'cash_session';
  static readonly eventType = 'caja_abierta';
  private constructor(readonly openingMinor: number, readonly openedAtMs: number, readonly previousCloseEventId: string | null) {}
  static fromJson(p: Record<string, unknown>): CajaAbiertaPayload {
    return new CajaAbiertaPayload(integer(p.opening_minor), integer(p.opened_at_ms,1), p.previous_close_event_id == null ? null : requiredUuidV4(p.previous_close_event_id,'previous_close_event_id'));
  }
  get dependencyEventIds(): string[] { return this.previousCloseEventId ? [this.previousCloseEventId] : []; }
  toJson(): Record<string, unknown> { return {opening_minor:this.openingMinor,opened_at_ms:this.openedAtMs,previous_close_event_id:this.previousCloseEventId}; }
}
