import {
  orderRecord,
  orderInt,
  orderUuid,
  orderPayloadSize,
} from './supplier-order-json';

/** Contrato documental v1 de las operaciones de pedidos S3. */
export class SupplierOrderCancelledPayload {
  static readonly aggregateType = 'supplier_order';
  static readonly eventType = 'supplier_order_cancelled';
  private constructor(
    readonly contractVersion: number,
    readonly orderId: string,
    readonly baseEventId: string,
    readonly occurredAtMs: number,
  ) {}
  static fromJson(value: unknown): SupplierOrderCancelledPayload {
    const j = orderRecord(value);
    orderPayloadSize(j);
    const p = new SupplierOrderCancelledPayload(
      orderInt(j['contract_version'], 1),
      orderUuid(j['order_id']),
      orderUuid(j['base_event_id']),
      orderInt(j['occurred_at_ms'], 1),
    );
    if (p.contractVersion !== 1) throw new Error('Versión inválida');
    return p;
  }
  toJson(): Record<string, unknown> {
    return {
      contract_version: this.contractVersion,
      order_id: this.orderId,
      base_event_id: this.baseEventId,
      occurred_at_ms: this.occurredAtMs,
    };
  }
}
