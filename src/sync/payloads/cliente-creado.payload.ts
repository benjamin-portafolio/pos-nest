export class ClienteCreadoPayload {
  static readonly aggregateType = 'cliente';
  static readonly eventType = 'cliente_creado';
  private constructor(
    readonly nombre: string,
    readonly telefono: string | null,
  ) {}

  static fromJson(json: Record<string, unknown>): ClienteCreadoPayload {
    if (typeof json.nombre !== 'string' || json.nombre.trim().length === 0) {
      throw new Error('El nombre del cliente es obligatorio.');
    }
    if (json.telefono != null && typeof json.telefono !== 'string') {
      throw new Error('El teléfono debe ser texto o null.');
    }
    return new ClienteCreadoPayload(
      json.nombre.trim(),
      (json.telefono as string | undefined)?.trim() || null,
    );
  }
  toJson(): Record<string, unknown> {
    return { nombre: this.nombre, telefono: this.telefono };
  }
}
