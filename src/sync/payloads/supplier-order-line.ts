import {
  orderRecord,
  orderInt,
  orderText,
  orderUuid,
  orderAmount,
} from './supplier-order-json';

/** Contrato documental v1 de las operaciones de pedidos S3. */
export class SupplierOrderLine {
  private constructor(
    readonly id: string,
    readonly variantId: string,
    readonly inventoryItemId: string,
    readonly unitId: string,
    readonly productNameSnapshot: string,
    readonly variantNameSnapshot: string | null,
    readonly dimension: string,
    readonly unitCodeSnapshot: string,
    readonly unitSymbolSnapshot: string,
    readonly unitAtomicFactor: number,
    readonly referenceQuantityAtomic: number,
    readonly quantityAtomic: number,
    readonly quotedPriceMinor: number | null,
    readonly totalMinor: number | null,
  ) {}
  static fromJson(value: unknown): SupplierOrderLine {
    const j = orderRecord(value);
    const p = new SupplierOrderLine(
      orderUuid(j['id']),
      orderUuid(j['variant_id']),
      orderUuid(j['inventory_item_id']),
      orderUuid(j['unit_id']),
      orderText(j['product_name_snapshot'], 160),
      j['variant_name_snapshot'] == null
        ? null
        : orderText(j['variant_name_snapshot'], 160),
      orderText(j['dimension'], 6),
      orderText(j['unit_code_snapshot'], 16),
      orderText(j['unit_symbol_snapshot'], 16),
      orderInt(j['unit_atomic_factor'], 1),
      orderInt(j['reference_quantity_atomic'], 1),
      orderInt(j['quantity_atomic'], 1),
      j['quoted_price_minor'] == null
        ? null
        : orderInt(j['quoted_price_minor']),
      j['total_minor'] == null ? null : orderInt(j['total_minor']),
    );
    if (
      !['count', 'mass', 'volume'].includes(p.dimension) ||
      (p.dimension === 'count' &&
        (p.unitAtomicFactor !== 1 || p.referenceQuantityAtomic !== 1)) ||
      (p.quotedPriceMinor === null
        ? p.totalMinor !== null
        : p.totalMinor !==
          orderAmount(
            p.quotedPriceMinor,
            p.quantityAtomic,
            p.referenceQuantityAtomic,
          ))
    )
      throw new Error('Unidad o importe incoherente');
    return p;
  }
  toJson(): Record<string, unknown> {
    return {
      id: this.id,
      variant_id: this.variantId,
      inventory_item_id: this.inventoryItemId,
      unit_id: this.unitId,
      product_name_snapshot: this.productNameSnapshot,
      variant_name_snapshot: this.variantNameSnapshot,
      dimension: this.dimension,
      unit_code_snapshot: this.unitCodeSnapshot,
      unit_symbol_snapshot: this.unitSymbolSnapshot,
      unit_atomic_factor: this.unitAtomicFactor,
      reference_quantity_atomic: this.referenceQuantityAtomic,
      quantity_atomic: this.quantityAtomic,
      quoted_price_minor: this.quotedPriceMinor,
      total_minor: this.totalMinor,
    };
  }
}
