import { SupplierJson } from './supplier-json';

export class ProductoProveedorPrecio {
  readonly supplierId: string;
  readonly quotedPriceMinor: number;
  readonly quotedAtMs: number;
  constructor(
    supplierId: string,
    quotedPriceMinor: number,
    quotedAtMs: number,
  ) {
    this.supplierId = SupplierJson.uuid(supplierId, 'supplier_id');
    this.quotedPriceMinor = SupplierJson.integer(
      quotedPriceMinor,
      'quoted_price_minor',
    );
    this.quotedAtMs = SupplierJson.integer(quotedAtMs, 'quoted_at_ms', 1);
    Object.freeze(this);
  }
  static fromJson(json: Record<string, unknown>): ProductoProveedorPrecio {
    return new ProductoProveedorPrecio(
      SupplierJson.uuid(json.supplier_id, 'supplier_id'),
      SupplierJson.integer(json.quoted_price_minor, 'quoted_price_minor'),
      SupplierJson.integer(json.quoted_at_ms, 'quoted_at_ms', 1),
    );
  }
  toJson(): Record<string, unknown> {
    return {
      supplier_id: this.supplierId,
      quoted_price_minor: this.quotedPriceMinor,
      quoted_at_ms: this.quotedAtMs,
    };
  }
  static parseVariant(
    json: Record<string, unknown>,
  ): readonly ProductoProveedorPrecio[] | null {
    if (!Object.prototype.hasOwnProperty.call(json, 'suppliers')) return null;
    if (!Array.isArray(json.suppliers))
      throw new Error('suppliers debe ser un arreglo, nunca null.');
    const values = json.suppliers.map((value) =>
      this.fromJson(SupplierJson.object(value, 'suppliers[]')),
    );
    if (new Set(values.map((value) => value.supplierId)).size !== values.length)
      throw new Error('Un proveedor no puede repetirse en la misma variante.');
    return Object.freeze(
      values.sort((a, b) => a.supplierId.localeCompare(b.supplierId)),
    );
  }
  static sameList(
    a: readonly ProductoProveedorPrecio[] | null | undefined,
    b: readonly ProductoProveedorPrecio[] | null | undefined,
  ): boolean {
    if (a == null || b == null) return a == null && b == null;
    return (
      a.length === b.length &&
      a.every((value) =>
        b.some(
          (other) =>
            value.supplierId === other.supplierId &&
            value.quotedPriceMinor === other.quotedPriceMinor &&
            value.quotedAtMs === other.quotedAtMs,
        ),
      )
    );
  }
}
