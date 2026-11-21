import {
  orderRecord,
  orderInt,
  orderUuid,
  orderLines,
  orderPayloadSize,
  orderTotal,
} from './supplier-order-json';
import { SupplierReceiptLine } from './supplier-receipt-line';

/** Contrato S1: no habilita recepción ni escritura de negocio. */
export class SupplierReceiptConfirmedPayload {
  static readonly aggregateType = 'supplier_order';
  static readonly eventType = 'supplier_receipt_confirmed';
  private constructor(
    readonly contractVersion: number,
    readonly orderId: string,
    readonly baseEventId: string,
    readonly occurredAtMs: number,
    readonly receiptId: string,
    readonly items: readonly SupplierReceiptLine[],
    readonly totalMinor: number,
  ) {}
  static fromJson(value: unknown): SupplierReceiptConfirmedPayload {
    const j = orderRecord(value);
    orderPayloadSize(j);
    const p = new SupplierReceiptConfirmedPayload(
      orderInt(j['contract_version'], 1),
      orderUuid(j['order_id']),
      orderUuid(j['base_event_id']),
      orderInt(j['occurred_at_ms'], 1),
      orderUuid(j['receipt_id']),
      orderLines(
        j['items'],
        SupplierReceiptLine.fromJson,
        (l) => l.orderItemId,
      ),
      orderInt(j['total_minor']),
    );
    if (p.contractVersion !== 1) throw new Error('Versión inválida');
    if (
      p.totalMinor !== orderTotal(p.items.map((l) => l.totalMinor)) ||
      new Set(p.items.map((l) => l.movementId)).size !== p.items.length
    )
      throw new Error('Recepción incoherente');
    return p;
  }
  toJson(): Record<string, unknown> {
    return {
      contract_version: this.contractVersion,
      order_id: this.orderId,
      base_event_id: this.baseEventId,
      occurred_at_ms: this.occurredAtMs,
      receipt_id: this.receiptId,
      items: this.items.map((l) => l.toJson()),
      total_minor: this.totalMinor,
    };
  }
}
