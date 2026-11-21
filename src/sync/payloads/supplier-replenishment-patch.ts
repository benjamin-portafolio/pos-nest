import { orderRecord, orderInt, orderUuid } from './supplier-order-json';
/** Omisión conserva; null retira. Integración en escritores de producto: S2. */
export class SupplierReplenishmentPatch {
  private constructor(
    readonly hasSupplier: boolean,
    readonly supplierId: string | null,
    readonly hasTarget: boolean,
    readonly targetAtomic: number | null,
  ) {}
  static fromJson(value: unknown): SupplierReplenishmentPatch {
    const j = orderRecord(value);
    return new SupplierReplenishmentPatch(
      Object.hasOwn(j, 'current_supplier_id'),
      j.current_supplier_id == null ? null : orderUuid(j.current_supplier_id),
      Object.hasOwn(j, 'target_stock_atomic'),
      j.target_stock_atomic == null ? null : orderInt(j.target_stock_atomic),
    );
  }
  toJson(): Record<string, unknown> {
    return {
      ...(this.hasSupplier ? { current_supplier_id: this.supplierId } : {}),
      ...(this.hasTarget ? { target_stock_atomic: this.targetAtomic } : {}),
    };
  }
}
