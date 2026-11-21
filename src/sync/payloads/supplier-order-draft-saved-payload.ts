import {
  orderRecord,
  orderInt,
  orderText,
  orderUuid,
  orderLines,
  orderPayloadSize,
  orderTotal,
} from './supplier-order-json';
import { SupplierOrderLine } from './supplier-order-line';

/** Contrato documental v1 de las operaciones de pedidos S3. */
export class SupplierOrderDraftSavedPayload {
  static readonly aggregateType = 'supplier_order';
  static readonly eventType = 'supplier_order_draft_saved';
  private constructor(
    readonly contractVersion: number,
    readonly orderId: string,
    readonly baseEventId: string | null,
    readonly supplierId: string,
    readonly supplierNameSnapshot: string,
    readonly supplierPhoneSnapshot: string | null,
    readonly currency: string,
    readonly occurredAtMs: number,
    readonly notes: string | null,
    readonly items: readonly SupplierOrderLine[],
    readonly totalMinor: number | null,
  ) {}
  static fromJson(value: unknown): SupplierOrderDraftSavedPayload {
    const j = orderRecord(value);
    orderPayloadSize(j);
    const p = new SupplierOrderDraftSavedPayload(
      orderInt(j['contract_version'], 1),
      orderUuid(j['order_id']),
      j['base_event_id'] == null ? null : orderUuid(j['base_event_id']),
      orderUuid(j['supplier_id']),
      orderText(j['supplier_name_snapshot'], 160),
      j['supplier_phone_snapshot'] == null
        ? null
        : orderText(j['supplier_phone_snapshot'], 80),
      orderText(j['currency'], 3),
      orderInt(j['occurred_at_ms'], 1),
      j['notes'] == null ? null : orderText(j['notes'], 1000),
      orderLines(j['items'], SupplierOrderLine.fromJson, (l) => l.id),
      j['total_minor'] == null ? null : orderInt(j['total_minor']),
    );
    if (
      p.contractVersion !== 1 ||
      !/^[A-Z]{3}$/.test(p.currency) ||
      p.totalMinor !== orderTotal(p.items.map((l) => l.totalMinor)) ||
      new Set(p.items.map((l) => l.variantId)).size !== p.items.length
    )
      throw new Error('Documento incoherente');
    return p;
  }
  toJson(): Record<string, unknown> {
    return {
      contract_version: this.contractVersion,
      order_id: this.orderId,
      base_event_id: this.baseEventId,
      supplier_id: this.supplierId,
      supplier_name_snapshot: this.supplierNameSnapshot,
      supplier_phone_snapshot: this.supplierPhoneSnapshot,
      currency: this.currency,
      occurred_at_ms: this.occurredAtMs,
      notes: this.notes,
      items: this.items.map((l) => l.toJson()),
      total_minor: this.totalMinor,
    };
  }
}
