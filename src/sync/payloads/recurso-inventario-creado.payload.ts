const MAX_SAFE_ATOMIC_QUANTITY = Number.MAX_SAFE_INTEGER;

export interface InitialInventoryMovementValue {
  movementId: string;
  movementType: 'manual_adjustment';
  quantityDeltaAtomic: number;
  reason: string;
}

export class RecursoInventarioCreadoPayload {
  static readonly aggregateType = 'inventory_item';
  static readonly eventType = 'recurso_inventario_creado';

  constructor(
    readonly inventoryItemId: string,
    readonly name: string,
    readonly defaultUnitId: string,
    readonly initialMovement: InitialInventoryMovementValue | null,
  ) {}

  static fromJson(
    payload: Record<string, unknown>,
  ): RecursoInventarioCreadoPayload {
    const item = requiredRecord(payload.inventory_item, 'inventory_item');
    const movementValue = payload.initial_movement;
    return new RecursoInventarioCreadoPayload(
      requiredUuidV4(
        item.inventory_item_id,
        'inventory_item.inventory_item_id',
      ),
      normalizeRequiredText(item.name, 'inventory_item.name', 160),
      requiredUuidV4(item.default_unit_id, 'inventory_item.default_unit_id'),
      movementValue === null || movementValue === undefined
        ? null
        : parseInitialMovement(
            requiredRecord(movementValue, 'initial_movement'),
          ),
    );
  }

  toJson(): Record<string, unknown> {
    return {
      inventory_item: {
        inventory_item_id: this.inventoryItemId,
        name: this.name,
        default_unit_id: this.defaultUnitId,
      },
      initial_movement: this.initialMovement
        ? {
            movement_id: this.initialMovement.movementId,
            movement_type: this.initialMovement.movementType,
            quantity_delta_atomic: this.initialMovement.quantityDeltaAtomic,
            reason: this.initialMovement.reason,
          }
        : null,
    };
  }
}

function parseInitialMovement(
  value: Record<string, unknown>,
): InitialInventoryMovementValue {
  if (value.movement_type !== 'manual_adjustment') {
    throw new Error(
      'initial_movement.movement_type debe ser manual_adjustment.',
    );
  }
  const quantityDeltaAtomic = value.quantity_delta_atomic;
  if (
    typeof quantityDeltaAtomic !== 'number' ||
    !Number.isSafeInteger(quantityDeltaAtomic) ||
    quantityDeltaAtomic === 0 ||
    Math.abs(quantityDeltaAtomic) > MAX_SAFE_ATOMIC_QUANTITY
  ) {
    throw new Error(
      'initial_movement.quantity_delta_atomic debe ser un entero seguro distinto de cero.',
    );
  }
  return {
    movementId: requiredUuidV4(
      value.movement_id,
      'initial_movement.movement_id',
    ),
    movementType: 'manual_adjustment',
    quantityDeltaAtomic,
    reason: normalizeRequiredText(value.reason, 'initial_movement.reason', 500),
  };
}

function requiredRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} debe ser un objeto.`);
  }
  return value as Record<string, unknown>;
}

function normalizeRequiredText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} debe ser texto.`);
  }
  const normalized = value.normalize('NFKC').trim();
  const length = [...normalized].length;
  if (length < 1 || length > maxLength) {
    throw new Error(
      `${fieldName} debe tener entre 1 y ${maxLength} caracteres.`,
    );
  }
  return normalized;
}

function requiredUuidV4(value: unknown, fieldName: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  ) {
    throw new Error(`${fieldName} debe ser un UUID v4.`);
  }
  return value.trim();
}
