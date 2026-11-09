import { normalizeRequiredText } from './inventory-movement.payload';

/** Baja lógica que conserva identidad, saldo e historial. */
export class RecursoInventarioEliminadoPayload {
  static readonly aggregateType = 'inventory_item';
  static readonly eventType = 'recurso_inventario_eliminado';
  private constructor(readonly baseEventId: string) {}

  static fromJson(
    payload: Record<string, unknown>,
  ): RecursoInventarioEliminadoPayload {
    if (
      Object.keys(payload).length !== 1 ||
      !Object.hasOwn(payload, 'base_event_id')
    ) {
      throw new Error(
        'La eliminación requiere únicamente base_event_id válido.',
      );
    }
    return new RecursoInventarioEliminadoPayload(
      normalizeRequiredText(payload.base_event_id, 'base_event_id', 120),
    );
  }

  toJson(): Record<string, unknown> {
    return { base_event_id: this.baseEventId };
  }
}
