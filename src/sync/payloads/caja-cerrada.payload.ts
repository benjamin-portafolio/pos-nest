import { isDeepStrictEqual } from 'util';
import { requiredUuidV4 } from './inventory-movement.payload';
import { integer } from './venta-confirmada.payload';
import { financialOptionalText } from './movimiento-financiero-registrado.payload';
import { CashMovementEvidence } from './cash-movement-evidence';
export class CajaCerradaPayload {
  static readonly aggregateType = 'cash_session';
  static readonly eventType = 'caja_cerrada';
  private constructor(readonly openingEventId: string, readonly closedAtMs: number, readonly countedMinor: number, readonly incomeMinor: string, readonly expenseMinor: string, readonly expectedMinor: string, readonly differenceMinor: string, readonly notes: string | null, readonly movements: CashMovementEvidence[]) {}
  static fromJson(p: Record<string, unknown>): CajaCerradaPayload {
    if (!Array.isArray(p.movements)) throw new Error('Falta la evidencia del corte.');
    const movements = p.movements.map(CashMovementEvidence.fromJson).sort((a,b)=>a.movementId < b.movementId ? -1 : a.movementId > b.movementId ? 1 : 0);
    if (new Set(movements.map(m=>m.movementId)).size !== movements.length || new Set(movements.map(m=>m.eventId)).size !== movements.length) throw new Error('Movimientos duplicados en corte.');
    return new CajaCerradaPayload(requiredUuidV4(p.opening_event_id,'opening_event_id'), integer(p.closed_at_ms,1), integer(p.counted_minor), decimal(p.income_minor), decimal(p.expense_minor), decimal(p.expected_minor), decimal(p.difference_minor), financialOptionalText(p.notes,'notes',500), movements);
  }
  get dependencyEventIds(): string[] { return [this.openingEventId,...this.movements.map(m=>m.eventId)]; }
  verify(opening: string, actual: CashMovementEvidence[]): void {
    const sorted = [...actual].sort((a,b)=>a.movementId < b.movementId ? -1 : a.movementId > b.movementId ? 1 : 0);
    const incoming = actual.filter(m=>m.direction==='in').reduce((s,m)=>s+BigInt(m.amountMinor),0n);
    const outgoing = actual.filter(m=>m.direction==='out').reduce((s,m)=>s+BigInt(m.amountMinor),0n);
    const expected = BigInt(opening)+incoming-outgoing;
    if (!isDeepStrictEqual(sorted.map(m=>m.toJson()),this.movements.map(m=>m.toJson())) || incoming.toString()!==this.incomeMinor || outgoing.toString()!==this.expenseMinor || expected.toString()!==this.expectedMinor || (BigInt(this.countedMinor)-expected).toString()!==this.differenceMinor) throw new Error('El conjunto o los totales del corte no coinciden.');
  }
  toJson(): Record<string, unknown> { return {opening_event_id:this.openingEventId,closed_at_ms:this.closedAtMs,counted_minor:this.countedMinor,income_minor:this.incomeMinor,expense_minor:this.expenseMinor,expected_minor:this.expectedMinor,difference_minor:this.differenceMinor,notes:this.notes,movements:this.movements.map(m=>m.toJson())}; }
}
function decimal(v: unknown): string {
  if (typeof v !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(v) || v.length > 100) throw new Error('Total decimal inválido.');
  return v;
}
