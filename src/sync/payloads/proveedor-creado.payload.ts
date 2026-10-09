import { SupplierJson } from './supplier-json';

/** Identidad y trazabilidad pertenecen al sobre, no al payload. */
export class ProveedorCreadoPayload {
  static readonly aggregateType = 'supplier';
  static readonly eventType = 'proveedor_creado';
  readonly name: string;
  readonly phone: string | null;
  readonly notes: string | null;
  constructor(
    name: string,
    phone: string | null = null,
    notes: string | null = null,
  ) {
    this.name = SupplierJson.requiredText(name, 'name');
    this.phone = SupplierJson.optionalText(phone, 'phone');
    this.notes = SupplierJson.optionalText(notes, 'notes');
    Object.freeze(this);
  }
  static fromJson(json: Record<string, unknown>): ProveedorCreadoPayload {
    SupplierJson.object(json, 'payload');
    return new ProveedorCreadoPayload(
      SupplierJson.requiredText(json.name, 'name'),
      SupplierJson.optionalText(json.phone, 'phone'),
      SupplierJson.optionalText(json.notes, 'notes'),
    );
  }
  toJson(): Record<string, unknown> {
    return { name: this.name, phone: this.phone, notes: this.notes };
  }
}
