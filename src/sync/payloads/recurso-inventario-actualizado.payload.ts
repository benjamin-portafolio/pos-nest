import {
  normalizeRequiredText,
  requiredRecord,
} from './inventory-movement.payload';

export class RecursoInventarioActualizadoPayload {
  static readonly aggregateType = 'inventory_item';
  static readonly eventType = 'recurso_inventario_actualizado';
  static readonly nameField = 'name';

  private constructor(
    readonly baseEventId: string,
    readonly previousName: string,
    readonly nextName: string,
  ) {}

  static fromJson(
    payload: Record<string, unknown>,
  ): RecursoInventarioActualizadoPayload {
    assertOnlyKeys(payload, ['base_event_id', 'changed_fields', 'changes']);
    if (
      !Array.isArray(payload.changed_fields) ||
      payload.changed_fields.length !== 1 ||
      payload.changed_fields[0] !== this.nameField
    ) {
      throw new Error(
        'recurso_inventario_actualizado solo admite changed_fields = [name].',
      );
    }
    const changes = requiredRecord(payload.changes, 'changes');
    assertOnlyKeys(changes, ['name'], 'changes');
    const name = requiredRecord(changes.name, 'changes.name');
    assertOnlyKeys(name, ['from', 'to'], 'changes.name');
    const previousName = normalizeRequiredText(
      name.from,
      'changes.name.from',
      160,
    );
    const nextName = normalizeRequiredText(name.to, 'changes.name.to', 160);
    if (previousName === nextName) {
      throw new Error('changes.name debe modificar el valor.');
    }
    return new RecursoInventarioActualizadoPayload(
      normalizeRequiredText(payload.base_event_id, 'base_event_id', 120),
      previousName,
      nextName,
    );
  }

  toJson(): Record<string, unknown> {
    return {
      base_event_id: this.baseEventId,
      changed_fields: [RecursoInventarioActualizadoPayload.nameField],
      changes: {
        name: { from: this.previousName, to: this.nextName },
      },
    };
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  fieldName = 'recurso_inventario_actualizado',
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${fieldName} contiene campos no permitidos: ${unexpected.join(', ')}.`,
    );
  }
}
