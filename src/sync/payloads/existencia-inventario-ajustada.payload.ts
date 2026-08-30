const MAX_SAFE_ATOMIC_QUANTITY = Number.MAX_SAFE_INTEGER;

export interface InventoryAdjustmentMovementValue {
  movementId: string;
  movementType: 'manual_adjustment';
  quantityDeltaAtomic: number;
  reason: string;
}

export class ExistenciaInventarioAjustadaPayload {
  static readonly aggregateType = 'inventory_item';
  static readonly eventType = 'existencia_inventario_ajustada';

  constructor(
    readonly inventoryItemId: string,
    readonly movement: InventoryAdjustmentMovementValue,
  ) {}

  static fromJson(
    payload: Record<string, unknown>,
  ): ExistenciaInventarioAjustadaPayload {
    const movement = requiredRecord(payload.movement, 'movement');
    if (movement.movement_type !== 'manual_adjustment') {
      throw new Error('movement.movement_type debe ser manual_adjustment.');
    }

    const quantityDeltaAtomic = movement.quantity_delta_atomic;
    if (
      typeof quantityDeltaAtomic !== 'number' ||
      !Number.isSafeInteger(quantityDeltaAtomic) ||
      quantityDeltaAtomic === 0 ||
      Math.abs(quantityDeltaAtomic) > MAX_SAFE_ATOMIC_QUANTITY
    ) {
      throw new Error(
        'movement.quantity_delta_atomic debe ser un entero seguro distinto de cero.',
      );
    }

    return new ExistenciaInventarioAjustadaPayload(
      requiredUuidV4(payload.inventory_item_id, 'inventory_item_id'),
      {
        movementId: requiredUuidV4(
          movement.movement_id,
          'movement.movement_id',
        ),
        movementType: 'manual_adjustment',
        quantityDeltaAtomic,
        reason: normalizeRequiredText(movement.reason, 'movement.reason', 500),
      },
    );
  }

  toJson(): Record<string, unknown> {
    return {
      inventory_item_id: this.inventoryItemId,
      movement: {
        movement_id: this.movement.movementId,
        movement_type: this.movement.movementType,
        quantity_delta_atomic: this.movement.quantityDeltaAtomic,
        reason: this.movement.reason,
      },
    };
  }
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
