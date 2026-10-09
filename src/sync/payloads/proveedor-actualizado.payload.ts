import { ProveedorCreadoPayload } from './proveedor-creado.payload';
import { SupplierJson } from './supplier-json';

export class ProveedorActualizadoPayload {
  static readonly aggregateType = 'supplier';
  static readonly eventType = 'proveedor_actualizado';
  readonly baseEventId: string;
  constructor(
    baseEventId: string,
    readonly before: ProveedorCreadoPayload,
    readonly after: ProveedorCreadoPayload,
  ) {
    this.baseEventId = SupplierJson.uuid(baseEventId, 'base_event_id');
    Object.freeze(this);
  }
  static fromJson(json: Record<string, unknown>): ProveedorActualizadoPayload {
    SupplierJson.object(json, 'payload');
    return new ProveedorActualizadoPayload(
      SupplierJson.uuid(json.base_event_id, 'base_event_id'),
      ProveedorCreadoPayload.fromJson(
        SupplierJson.object(json.before, 'before'),
      ),
      ProveedorCreadoPayload.fromJson(SupplierJson.object(json.after, 'after')),
    );
  }
  static sameState(
    a: ProveedorCreadoPayload,
    b: ProveedorCreadoPayload,
  ): boolean {
    return a.name === b.name && a.phone === b.phone && a.notes === b.notes;
  }
  toJson(): Record<string, unknown> {
    return {
      base_event_id: this.baseEventId,
      before: this.before.toJson(),
      after: this.after.toJson(),
    };
  }
}
