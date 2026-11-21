import {
  orderRecord,
  orderInt,
  orderUuid,
  orderAmount,
} from './supplier-order-json';

/** Contrato S1: no habilita recepción ni escritura de negocio. */
export class SupplierReceiptLine {
  private constructor(
    readonly orderItemId: string,
    readonly movementId: string,
    readonly quantityAtomic: number,
    readonly actualPriceMinor: number,
    readonly referenceQuantityAtomic: number,
    readonly totalMinor: number,
    readonly overageAcknowledged: boolean,
  ) {}
  static fromJson(value: unknown): SupplierReceiptLine {
    const j = orderRecord(value);
    const p = new SupplierReceiptLine(
      orderUuid(j['order_item_id']),
      orderUuid(j['movement_id']),
      orderInt(j['quantity_atomic'], 1),
      orderInt(j['actual_price_minor']),
      orderInt(j['reference_quantity_atomic'], 1),
      orderInt(j['total_minor']),
      typeof j.overage_acknowledged === 'boolean'
        ? j.overage_acknowledged
        : (() => {
            throw new Error('Booleano requerido');
          })(),
    );
    if (
      p.totalMinor !==
      orderAmount(
        p.actualPriceMinor,
        p.quantityAtomic,
        p.referenceQuantityAtomic,
      )
    )
      throw new Error('Importe incoherente');
    return p;
  }
  toJson(): Record<string, unknown> {
    return {
      order_item_id: this.orderItemId,
      movement_id: this.movementId,
      quantity_atomic: this.quantityAtomic,
      actual_price_minor: this.actualPriceMinor,
      reference_quantity_atomic: this.referenceQuantityAtomic,
      total_minor: this.totalMinor,
      overage_acknowledged: this.overageAcknowledged,
    };
  }
}
