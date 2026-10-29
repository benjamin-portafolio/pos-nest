import { SaleAdjustmentPayloadData as Adjustment } from './sale-adjustment-data';
import { VentaConfirmadaPayload } from './venta-confirmada.payload';
import { SaleAdjustmentRules, AdjustmentRef } from './sale-adjustment-rules';
import { SaleAdjustmentDeliveryPolicy } from './sale-adjustment-delivery-policy';
import { VentaAnuladaPayload } from './venta-anulada.payload';
import { DevolucionVentaRegistradaPayload } from './devolucion-venta-registrada.payload';
export interface SaleAdjustmentCommand {
  payload: Adjustment;
  userId: string;
  deviceId: string;
}
export interface AdjustmentEnvelope {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  device_id: string;
  user_id: string;
  created_at_local: string;
  base_version: number;
  base_server_sequence: number | null;
  payload: Adjustment;
  delivery_status: string;
}
/** Pure contract, not registered in the receiver/transport. */
export class SaleAdjustmentCommandContract {
  static prepare(
    command: SaleAdjustmentCommand,
    original: VentaConfirmadaPayload,
    saleId: string,
    confirmationEventId: string,
    history: Adjustment[],
    mode: string,
    integrationVerified = false,
    effectiveBaseServerSequence: number | null = null,
  ): { event: AdjustmentEnvelope; refs: AdjustmentRef[] } {
    const policy = SaleAdjustmentDeliveryPolicy.forMode(
        mode,
        integrationVerified,
      ),
      p = command.payload;
    if (
      !command.userId.trim() ||
      !command.deviceId.trim() ||
      p.expected_revision >= Number.MAX_SAFE_INTEGER ||
      (effectiveBaseServerSequence !== null &&
        (!Number.isSafeInteger(effectiveBaseServerSequence) ||
          effectiveBaseServerSequence <= 0))
    )
      throw new Error('Contexto o base inválidos.');
    SaleAdjustmentRules.validate(
      p,
      original,
      confirmationEventId,
      saleId,
      history,
    );
    const refs = SaleAdjustmentRules.refs(p, original);
    return {
      event: {
        event_id: p.event_id,
        aggregate_type: 'sale',
        aggregate_id: p.sale_id,
        event_type:
          p.kind === 'void'
            ? VentaAnuladaPayload.eventType
            : DevolucionVentaRegistradaPayload.eventType,
        device_id: command.deviceId,
        user_id: command.userId,
        created_at_local: new Date(p.occurred_at_ms).toISOString(),
        base_version: p.expected_revision + 1,
        base_server_sequence:
          mode === 'standalone' ? null : effectiveBaseServerSequence,
        payload: p,
        delivery_status: policy.delivery_status as string,
      },
      refs,
    };
  }
  static sameIntention(a: AdjustmentEnvelope, b: AdjustmentEnvelope): boolean {
    const business = (e: AdjustmentEnvelope) => ({
      event_id: e.event_id,
      aggregate_type: e.aggregate_type,
      aggregate_id: e.aggregate_id,
      event_type: e.event_type,
      device_id: e.device_id,
      user_id: e.user_id,
      created_at_ms: new Date(e.created_at_local).getTime(),
      base_version: e.base_version,
      payload: e.payload,
    });
    return (
      JSON.stringify(canonical(business(a))) ===
      JSON.stringify(canonical(business(b)))
    );
  }
}
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}

export interface SaleAdjustmentReadDocument {
  operationId: string;
  eventId: string;
  saleId: string;
  businessDate: string;
  reason: string;
  userId: string;
  deviceId: string;
  occurredAt: string;
  amountMinor: number;
  deliveryStatus: string;
  officialStatus: 'current' | 'voided' | 'partiallyReturned' | 'fullyReturned';
  localStatus: SaleAdjustmentReadDocument['officialStatus'];
  officialRevision: number;
  localRevision: number;
  incidentId: string | null;
  method: string;
  settlementAction: string;
  lines: readonly {
    saleItemId: string;
    quantityAtomic: number;
    amountMinor: number;
    recoveredCostMinor: number | null;
    destination: string;
  }[];
  physicalEffectIds: readonly string[];
}

/** Duplicate carries the original terminal/transient state. Pending is retryable. */
export interface SaleAdjustmentOutcome {
  eventId: string;
  operationId: string;
  status: 'pending' | 'accepted' | 'duplicate' | 'conflict' | 'rejected';
  originalStatus: SaleAdjustmentOutcome['status'] | null;
  serverSequence: number | null;
  reason: string | null;
  winnerEventId: string | null;
  blockedByEventId: string | null;
}
