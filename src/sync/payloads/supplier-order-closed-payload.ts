import {
  orderRecord,
  orderInt,
  orderUuid,
  orderLines,
  orderPayloadSize,
} from './supplier-order-json';
import { SupplierClosedLine } from './supplier-closed-line';

/** Contrato S1: no habilita recepción ni escritura de negocio. */
export class SupplierOrderClosedPayload {
  static readonly aggregateType = 'supplier_order';
  static readonly eventType = 'supplier_order_closed';
  private constructor(
    readonly contractVersion: number,
    readonly orderId: string,
    readonly baseEventId: string,
    readonly occurredAtMs: number,
    readonly items: readonly SupplierClosedLine[],
  ) {}
  static fromJson(value: unknown): SupplierOrderClosedPayload {
    const j = orderRecord(value);
    orderPayloadSize(j);
    const p = new SupplierOrderClosedPayload(
      orderInt(j['contract_version'], 1),
      orderUuid(j['order_id']),
      orderUuid(j['base_event_id']),
      orderInt(j['occurred_at_ms'], 1),
      orderLines(j['items'], SupplierClosedLine.fromJson, (l) => l.orderItemId),
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
      items: this.items.map((l) => l.toJson()),
    };
  }
}
