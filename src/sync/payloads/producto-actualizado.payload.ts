import { ProductoProveedorPrecio } from './producto-proveedor-precio';
import { ProductoCreadoPayload } from './producto-creado.payload';

export class ProductoActualizadoPayload {
  static readonly aggregateType = 'product';
  static readonly eventType = 'producto_actualizado';
  constructor(
    readonly baseEventId: string,
    readonly before: ProductoCreadoPayload,
    readonly after: ProductoCreadoPayload,
    readonly deleteProduct = false,
  ) {
    if (before.knowsSuppliers !== after.knowsSuppliers && !deleteProduct)
      throw new Error(
        'La edición debe conocer suppliers en before y after, o conservar ambos estados legados.',
      );
    if (
      JSON.stringify(before.saleConfiguration) !==
      JSON.stringify(after.saleConfiguration)
    )
      throw new Error('No se puede cambiar la forma de venta.');
    if (deleteProduct && !ProductoActualizadoPayload.sameState(before, after))
      throw new Error('El borrado debe conservar el estado anterior.');
  }
  static fromJson(json: Record<string, unknown>): ProductoActualizadoPayload {
    if (
      typeof json.base_event_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        json.base_event_id,
      )
    )
      throw new Error('Evento base inválido.');
    const read = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Estado de producto inválido.');
      return ProductoCreadoPayload.fromJson(value as Record<string, unknown>);
    };
    if ('delete_product' in json && typeof json.delete_product !== 'boolean')
      throw new Error('delete_product debe ser booleano.');
    const deleteProduct = json.delete_product === true;
    if (deleteProduct && json.after !== null)
      throw new Error(
        'El borrado conserva el estado anterior en before y requiere after null.',
      );
    const before = read(json.before);
    const after = deleteProduct ? before : read(json.after);
    return new ProductoActualizadoPayload(
      json.base_event_id,
      before,
      after,
      deleteProduct,
    );
  }
  static sameState(
    a: ProductoCreadoPayload,
    b: ProductoCreadoPayload,
  ): boolean {
    if (
      a.name !== b.name ||
      a.categoryId !== b.categoryId ||
      JSON.stringify(a.saleConfiguration) !==
        JSON.stringify(b.saleConfiguration) ||
      a.variants.length !== b.variants.length
    )
      return false;
    return a.variants.every((v) => {
      const other = b.variants.find((candidate) => candidate.id === v.id);
      return (
        other != null &&
        v.name === other.name &&
        v.nameKey === other.nameKey &&
        v.barcode === other.barcode &&
        v.salePriceMinor === other.salePriceMinor &&
        v.standardCostMinor === other.standardCostMinor &&
        v.inventoryItemId === other.inventoryItemId &&
        v.sortOrder === other.sortOrder &&
        ProductoProveedorPrecio.sameList(v.suppliers, other.suppliers) &&
        v.recipeComponents.length === other.recipeComponents.length &&
        v.recipeComponents.every((c) =>
          other.recipeComponents.some(
            (d) =>
              c.inventoryItemId === d.inventoryItemId &&
              c.quantityAtomic === d.quantityAtomic,
          ),
        )
      );
    });
  }
  static sameEditingBase(
    current: ProductoCreadoPayload,
    before: ProductoCreadoPayload,
  ): boolean {
    return (
      this.sameState(current, before) ||
      (!current.knowsSuppliers &&
        before.knowsSuppliers &&
        this.sameState(current.withKnownSuppliers(), before))
    );
  }
  get dependencyEventIds(): ReadonlySet<string> {
    return new Set([
      this.baseEventId,
      ...(this.deleteProduct ? [] : this.after.dependencyEventIds),
    ]);
  }
  get removedVariants() {
    return this.before.variants.filter(
      (v) =>
        this.deleteProduct ||
        !this.after.variants.some((next) => next.id === v.id),
    );
  }
  toJson(): Record<string, unknown> {
    return {
      base_event_id: this.baseEventId,
      ...(this.deleteProduct ? { delete_product: true } : {}),
      before: this.before.toJson(),
      after: this.deleteProduct
        ? null
        : this.after.toJson({
            includeCategoryDependency: false,
            includeInventoryEventDependencies: false,
          }),
    };
  }
}
