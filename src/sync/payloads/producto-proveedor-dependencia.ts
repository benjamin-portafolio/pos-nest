import { SupplierJson } from './supplier-json';

export class ProductoProveedorDependencia {
  readonly refId: string;
  readonly dependsOnEventId: string | null;
  constructor(refId: string, dependsOnEventId: string | null = null) {
    this.refId = SupplierJson.uuid(refId, 'supplier.ref_id');
    this.dependsOnEventId =
      dependsOnEventId == null
        ? null
        : SupplierJson.uuid(dependsOnEventId, 'supplier.depends_on_event_id');
    Object.freeze(this);
  }
  static fromJson(json: Record<string, unknown>): ProductoProveedorDependencia {
    return new ProductoProveedorDependencia(
      SupplierJson.uuid(json.ref_id, 'supplier.ref_id'),
      json.depends_on_event_id == null
        ? null
        : SupplierJson.uuid(
            json.depends_on_event_id,
            'supplier.depends_on_event_id',
          ),
    );
  }
  toJson(): Record<string, unknown> {
    return {
      ref_type: 'supplier',
      ref_id: this.refId,
      ...(this.dependsOnEventId == null
        ? {}
        : { depends_on_event_id: this.dependsOnEventId }),
    };
  }
  static validate(
    expected: ReadonlySet<string>,
    values: readonly ProductoProveedorDependencia[],
  ): readonly ProductoProveedorDependencia[] {
    const ids = new Set(values.map((value) => value.refId));
    if (ids.size !== values.length)
      throw new Error('Dependencias supplier duplicadas.');
    if (ids.size !== expected.size || [...expected].some((id) => !ids.has(id)))
      throw new Error(
        'Las dependencias supplier deben coincidir con los proveedores de las variantes.',
      );
    return Object.freeze(
      [...values].sort((a, b) => a.refId.localeCompare(b.refId)),
    );
  }
}
