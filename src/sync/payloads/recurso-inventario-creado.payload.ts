import {
  InventoryMovementPayload,
  normalizeRequiredText,
  requiredRecord,
  requiredUuidV4,
} from './inventory-movement.payload';

export class RecursoInventarioCreadoPayload {
  static readonly aggregateType = 'inventory_item';
  static readonly eventType = 'recurso_inventario_creado';

  constructor(
    readonly inventoryItemId: string,
    readonly name: string,
    readonly defaultUnitId: string,
    readonly initialMovement: InventoryMovementPayload | null,
  ) {}

  static fromJson(
    payload: Record<string, unknown>,
  ): RecursoInventarioCreadoPayload {
    const item = requiredRecord(payload.inventory_item, 'inventory_item');
    const movementValue = payload.initial_movement;
    const movement =
      movementValue === null || movementValue === undefined
        ? null
        : InventoryMovementPayload.fromJson(
            requiredRecord(movementValue, 'initial_movement'),
          );
    if (
      movement !== null &&
      movement.movementType !== 'initial_balance' &&
      movement.movementType !== 'manual_adjustment'
    ) {
      throw new Error(
        'initial_movement debe usar initial_balance o manual_adjustment legado.',
      );
    }
    return new RecursoInventarioCreadoPayload(
      requiredUuidV4(
        item.inventory_item_id,
        'inventory_item.inventory_item_id',
      ),
      normalizeRequiredText(item.name, 'inventory_item.name', 160),
      requiredUuidV4(item.default_unit_id, 'inventory_item.default_unit_id'),
      movement,
    );
  }

  toJson(): Record<string, unknown> {
    return {
      inventory_item: {
        inventory_item_id: this.inventoryItemId,
        name: this.name,
        default_unit_id: this.defaultUnitId,
      },
      initial_movement: this.initialMovement?.toJson() ?? null,
    };
  }
}
