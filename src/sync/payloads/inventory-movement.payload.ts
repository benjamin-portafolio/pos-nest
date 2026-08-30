export type InventoryMovementType =
  | 'initial_balance'
  | 'stock_receipt'
  | 'manual_adjustment'
  | 'reversal';

const MOVEMENT_TYPES = new Set<InventoryMovementType>([
  'initial_balance',
  'stock_receipt',
  'manual_adjustment',
  'reversal',
]);

export const MAX_SAFE_ATOMIC_QUANTITY = Number.MAX_SAFE_INTEGER;

export class InventoryMovementPayload {
  private constructor(
    readonly movementId: string,
    readonly movementType: InventoryMovementType,
    readonly quantityDeltaAtomic: number,
    readonly reason: string | null,
    readonly reversalOfMovementId: string | null,
  ) {}

  static fromJson(value: Record<string, unknown>): InventoryMovementPayload {
    const movementType = requiredMovementType(value.movement_type);
    const quantity = value.quantity_delta_atomic;
    if (
      typeof quantity !== 'number' ||
      !Number.isSafeInteger(quantity) ||
      quantity === 0 ||
      Math.abs(quantity) > MAX_SAFE_ATOMIC_QUANTITY
    ) {
      throw new Error(
        'movement.quantity_delta_atomic debe ser un entero seguro distinto de cero.',
      );
    }
    if (
      value.total_cost_minor !== null &&
      value.total_cost_minor !== undefined
    ) {
      throw new Error('movement.total_cost_minor debe permanecer null.');
    }
    const movementId = requiredUuidV4(
      value.movement_id,
      'movement.movement_id',
    );
    const reason = optionalReason(value.reason);
    const reversalOfMovementId = optionalUuidV4(
      value.reversal_of_movement_id,
      'movement.reversal_of_movement_id',
    );

    if (
      (movementType === 'initial_balance' ||
        movementType === 'stock_receipt') &&
      quantity <= 0
    ) {
      throw new Error(`${movementType} requiere un delta positivo.`);
    }
    if (movementType === 'manual_adjustment' && reason === null) {
      throw new Error('manual_adjustment requiere un motivo.');
    }
    if (movementType === 'reversal' && reversalOfMovementId === null) {
      throw new Error('reversal requiere reversal_of_movement_id.');
    }
    if (movementType !== 'reversal' && reversalOfMovementId !== null) {
      throw new Error('Solo reversal admite reversal_of_movement_id.');
    }
    if (movementId === reversalOfMovementId) {
      throw new Error('Un movimiento no puede revertirse a sí mismo.');
    }

    return new InventoryMovementPayload(
      movementId,
      movementType,
      quantity,
      reason,
      reversalOfMovementId,
    );
  }

  toJson(): Record<string, unknown> {
    return {
      movement_id: this.movementId,
      movement_type: this.movementType,
      quantity_delta_atomic: this.quantityDeltaAtomic,
      reason: this.reason,
      reversal_of_movement_id: this.reversalOfMovementId,
      total_cost_minor: null,
    };
  }
}

export function requiredRecord(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} debe ser un objeto.`);
  }
  return value as Record<string, unknown>;
}

export function normalizeRequiredText(
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

export function requiredUuidV4(value: unknown, fieldName: string): string {
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

function requiredMovementType(value: unknown): InventoryMovementType {
  if (
    typeof value !== 'string' ||
    !MOVEMENT_TYPES.has(value as InventoryMovementType)
  ) {
    throw new Error('movement.movement_type no está permitido.');
  }
  return value as InventoryMovementType;
}

function optionalReason(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return normalizeRequiredText(value, 'movement.reason', 500);
}

function optionalUuidV4(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredUuidV4(value, fieldName);
}
