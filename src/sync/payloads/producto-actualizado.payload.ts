import { ProductoCreadoPayload } from './producto-creado.payload';

export class ProductoActualizadoPayload {
  static readonly aggregateType = 'product';
  static readonly eventType = 'producto_actualizado';
  constructor(
    readonly baseEventId: string,
    readonly before: ProductoCreadoPayload,
    readonly after: ProductoCreadoPayload,
  ) {}
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
    const before = read(json.before);
    const after = read(json.after);
    if (
      JSON.stringify(before.saleConfiguration) !==
      JSON.stringify(after.saleConfiguration)
    )
      throw new Error('No se puede cambiar la forma de venta.');
    const ids = new Set(after.variants.map((v) => v.id));
    if (!before.variants.every((v) => ids.has(v.id)))
      throw new Error('Deben conservarse las variantes existentes.');
    return new ProductoActualizadoPayload(json.base_event_id, before, after);
  }
  toJson(): Record<string, unknown> {
    return {
      base_event_id: this.baseEventId,
      before: this.before.toJson(),
      after: this.after.toJson({
        includeCategoryDependency: false,
        includeInventoryEventDependencies: false,
      }),
    };
  }
}
