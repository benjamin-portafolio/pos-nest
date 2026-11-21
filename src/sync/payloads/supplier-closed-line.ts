import { orderRecord, orderInt, orderUuid } from './supplier-order-json';

/** Contrato S1: no habilita recepción ni escritura de negocio. */
export class SupplierClosedLine {
  private constructor(
    readonly orderItemId: string,
    readonly closedQuantityAtomic: number,
  ) {}
  static fromJson(value: unknown): SupplierClosedLine {
    const j = orderRecord(value);
    const p = new SupplierClosedLine(
      orderUuid(j['order_item_id']),
      orderInt(j['closed_quantity_atomic'], 1),
    );
    return p;
  }
  toJson(): Record<string, unknown> {
    return {
      order_item_id: this.orderItemId,
      closed_quantity_atomic: this.closedQuantityAtomic,
    };
  }
}
