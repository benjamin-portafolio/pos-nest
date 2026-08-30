import {
  InventoryMovementPayload,
  normalizeRequiredText,
  requiredRecord,
} from './inventory-movement.payload';

export class MovimientoInventarioRegistradoPayload {
  static readonly aggregateType = 'inventory_item';
  static readonly eventType = 'movimiento_inventario_registrado';

  private constructor(
    readonly baseEventId: string,
    readonly movement: InventoryMovementPayload,
  ) {}

  static fromJson(
    payload: Record<string, unknown>,
  ): MovimientoInventarioRegistradoPayload {
    return new MovimientoInventarioRegistradoPayload(
      normalizeRequiredText(payload.base_event_id, 'base_event_id', 120),
      InventoryMovementPayload.fromJson(
        requiredRecord(payload.movement, 'movement'),
      ),
    );
  }

  toJson(): Record<string, unknown> {
    return {
      base_event_id: this.baseEventId,
      movement: this.movement.toJson(),
    };
  }
}
