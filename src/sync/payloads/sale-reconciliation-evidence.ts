import { createHash } from 'crypto';
import { SaleAdjustmentPayloadData } from './sale-adjustment-data';
import { SaleReconciliationEffect } from './operacion-venta-conciliada.payload';
export function documentaryEffectId(
  operationId: string,
  ledger: string,
): string {
  const bytes = createHash('sha256')
    .update(`pos.sale-adjustment.effect.v1/${ledger}/${operationId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function saleReconciliationEvidence(
  p: SaleAdjustmentPayloadData,
): SaleReconciliationEffect[] {
  const effect = (
    id: string,
    ledger: string,
    target: string,
    delta: number,
  ): SaleReconciliationEffect => ({
    effect_id: id,
    ledger,
    target_id: target,
    delta,
    occurred_at_ms: p.occurred_at_ms,
    utc_offset_minutes: p.utc_offset_minutes,
    business_date: p.business_date,
    cash_session_id:
      ledger === 'cash'
        ? ((p.settlement.cash?.session_id as string | undefined) ?? null)
        : null,
    opening_event_id:
      ledger === 'cash'
        ? ((p.settlement.cash?.opening_event_id as string | undefined) ?? null)
        : null,
  });
  return [
    ...p.lines.flatMap((l) =>
      l.stock.map((s) =>
        effect(s.movement_id, 'stock', s.inventory_item_id, s.quantity_atomic),
      ),
    ),
    ...(p.total_minor > 0
      ? [
          effect(
            (p.settlement.cash?.movement_id as string | undefined) ??
              documentaryEffectId(p.operation_id, p.settlement.method),
            p.settlement.method === 'cash'
              ? 'cash'
              : p.settlement.method === 'credit'
                ? 'credit'
                : 'transfer',
            p.settlement.method === 'credit'
              ? p.settlement.cliente_id!
              : ((p.settlement.cash?.movement_id as string | undefined) ??
                  p.operation_id),
            p.settlement.method === 'credit' ? p.total_minor : -p.total_minor,
          ),
        ]
      : []),
  ];
}
