import {
  InventoryMovementPayload,
  normalizeRequiredText,
  requiredRecord,
  requiredUuidV4,
} from './inventory-movement.payload';

export class RecursoInventarioCreadoPayload {
  static readonly aggregateType = 'inventory_item';
  static readonly eventType = 'recurso_inventario_creado';

  /**
   * Clave del origen dentro de `inventory_item`. La comparten este contrato y
   * los registros, revalidadores y pruebas: no se repite el literal.
   */
  static readonly originVariantIdField = 'origin_variant_id';

  constructor(
    readonly inventoryItemId: string,
    readonly name: string,
    readonly defaultUnitId: string,
    readonly initialMovement: InventoryMovementPayload | null,
    /**
     * Procedencia: variante que originó el recurso. Solo este evento la
     * establece; editar el nombre o mover stock no la modifica. Es una
     * identidad, no una FK: el recurso se aplica antes de que exista la
     * variante. `null` significa desconocido (recursos independientes, eventos
     * legados y `null` explícito).
     */
    readonly originVariantId: string | null,
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
      readOriginVariantId(item),
    );
  }

  toJson(): Record<string, unknown> {
    return {
      inventory_item: {
        inventory_item_id: this.inventoryItemId,
        name: this.name,
        default_unit_id: this.defaultUnitId,
        // Se omite cuando no hay procedencia: la forma canónica de un recurso
        // independiente o legado no cambia y no se inventa un origen.
        ...(this.originVariantId !== null
          ? {
              [RecursoInventarioCreadoPayload.originVariantIdField]:
                this.originVariantId,
            }
          : {}),
      },
      initial_movement: this.initialMovement?.toJson() ?? null,
    };
  }
}

/**
 * Ausencia y `null` se leen como desconocido. Un valor presente debe ser un
 * UUID v4; cualquier otra cosa se rechaza en lugar de convertirse en `null`.
 */
export function readOriginVariantId(
  item: Record<string, unknown>,
): string | null {
  const raw = item[RecursoInventarioCreadoPayload.originVariantIdField];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new Error(
      `inventory_item.${RecursoInventarioCreadoPayload.originVariantIdField} debe ser un UUID v4 o null.`,
    );
  }
  return requiredUuidV4(
    raw,
    `inventory_item.${RecursoInventarioCreadoPayload.originVariantIdField}`,
  );
}
