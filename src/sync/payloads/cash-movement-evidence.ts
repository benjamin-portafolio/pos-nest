import { requiredRecord, requiredUuidV4 } from './inventory-movement.payload';
import { integer } from './venta-confirmada.payload';
export class CashMovementEvidence {
  private constructor(readonly movementId: string, readonly eventId: string, readonly direction: string, readonly amountMinor: number, readonly sourceType: string, readonly sourceId: string) {}
  static fromJson(value: unknown): CashMovementEvidence {
    const p = requiredRecord(value, 'movement');
    if (!['in','out'].includes(p.direction as string) || !['sale_payment','customer_payment','financial_entry'].includes(p.source_type as string)) throw new Error('Origen o dirección de caja inválidos.');
    if (p.source_type !== 'financial_entry' && p.direction !== 'in') throw new Error('Un cobro debe ser entrada.');
    return new CashMovementEvidence(requiredUuidV4(p.movement_id,'movement_id'), requiredUuidV4(p.event_id,'event_id'), p.direction as string, integer(p.amount_minor,1), p.source_type as string, requiredUuidV4(p.source_id,'source_id'));
  }
  toJson(): Record<string, unknown> { return {movement_id:this.movementId,event_id:this.eventId,direction:this.direction,amount_minor:this.amountMinor,source_type:this.sourceType,source_id:this.sourceId}; }
}
