export interface CategoriaCreadaPayload {
  name: string;
  colorKey: string;
  sortOrder: number;
}

export type CategoriaMutableField = 'name' | 'color_key';

export interface CategoriaFieldChange<T> {
  from: T;
  to: T;
}

export interface CategoriaActualizadaPayload {
  baseEventId: string;
  changedFields: CategoriaMutableField[];
  name: CategoriaFieldChange<string> | null;
  colorKey: CategoriaFieldChange<string> | null;
}

export interface CategoriaMovidaPayload {
  baseEventId: string;
  fromOrder: number;
  toOrder: number;
  displacedCategoryId: string;
  displacedBaseEventId: string;
  displacedBaseVersion: number;
  displacedBaseServerSequence: number | null;
  displacedFromOrder: number;
  displacedToOrder: number;
}

export const CATEGORIA_CREADA = 'categoria_creada';
export const CATEGORIA_ACTUALIZADA = 'categoria_actualizada';
export const CATEGORIA_MOVIDA = 'categoria_movida';
export const CATEGORY_SORT_ORDER_FIELD = 'sort_order';
export const CATEGORY_MUTABLE_FIELDS = new Set<CategoriaMutableField>([
  'name',
  'color_key',
]);

export const CATEGORY_COLOR_KEYS = new Set([
  'neutral',
  'amber',
  'blue',
  'blue_grey',
  'brown',
  'cyan',
  'deep_orange',
  'deep_purple',
  'green',
  'grey',
  'indigo',
  'light_blue',
  'light_green',
  'lime',
  'orange',
  'pink',
  'purple',
  'red',
  'teal',
  'yellow',
]);

/** Pure parsers shared by the normal receiver and recovery validation. */
export class CategoriaEventContract {
  static parseCategoriaCreadaPayload(
    payload: Record<string, unknown>,
  ): CategoriaCreadaPayload | { error: string } {
    if (typeof payload.name !== 'string' || payload.name.trim() === '') {
      return { error: 'payload.name es obligatorio.' };
    }

    if (
      typeof payload.color_key !== 'string' ||
      !CATEGORY_COLOR_KEYS.has(payload.color_key)
    ) {
      return { error: 'payload.color_key no pertenece a la paleta permitida.' };
    }

    const sortOrder = this.readNonNegativeInteger(payload.sort_order);
    if (sortOrder === null) {
      return { error: 'payload.sort_order debe ser un entero >= 0.' };
    }

    return {
      name: payload.name.trim(),
      colorKey: payload.color_key,
      sortOrder,
    };
  }

  static parseCategoriaMovidaPayload(
    payload: Record<string, unknown>,
  ): CategoriaMovidaPayload | { error: string } {
    if (
      typeof payload.base_event_id !== 'string' ||
      payload.base_event_id.trim() === ''
    ) {
      return { error: 'payload.base_event_id es obligatorio.' };
    }
    if (
      !Array.isArray(payload.changed_fields) ||
      payload.changed_fields.length !== 1 ||
      payload.changed_fields[0] !== CATEGORY_SORT_ORDER_FIELD
    ) {
      return {
        error: 'categoria_movida requiere changed_fields = [sort_order].',
      };
    }
    if (!this.isRecord(payload.changes)) {
      return { error: 'payload.changes es obligatorio.' };
    }
    const orderChange = this.readIntegerChange(
      payload.changes,
      CATEGORY_SORT_ORDER_FIELD,
    );
    if ('error' in orderChange) return orderChange;

    if (!this.isRecord(payload.displaced_category)) {
      return { error: 'payload.displaced_category es obligatorio.' };
    }
    const displaced = payload.displaced_category;
    if (
      typeof displaced.category_id !== 'string' ||
      displaced.category_id.trim() === ''
    ) {
      return {
        error: 'displaced_category.category_id es obligatorio.',
      };
    }
    if (
      typeof displaced.base_event_id !== 'string' ||
      displaced.base_event_id.trim() === ''
    ) {
      return {
        error: 'displaced_category.base_event_id es obligatorio.',
      };
    }
    const displacedBaseVersion = this.readPositiveInteger(
      displaced.base_version,
    );
    if (displacedBaseVersion === null) {
      return {
        error: 'displaced_category.base_version debe ser un entero >= 1.',
      };
    }
    const displacedBaseServerSequence = this.toNullableNumber(
      displaced.base_server_sequence as string | number | null | undefined,
    );
    if (
      displaced.base_server_sequence !== null &&
      displaced.base_server_sequence !== undefined &&
      (displacedBaseServerSequence === null || displacedBaseServerSequence < 0)
    ) {
      return {
        error:
          'displaced_category.base_server_sequence debe ser un entero >= 0 o null.',
      };
    }
    const displacedOrderChange = this.readIntegerChange(
      displaced,
      CATEGORY_SORT_ORDER_FIELD,
    );
    if ('error' in displacedOrderChange) return displacedOrderChange;

    if (
      Math.abs(orderChange.from - displacedOrderChange.from) !== 1 ||
      orderChange.to !== displacedOrderChange.from ||
      displacedOrderChange.to !== orderChange.from
    ) {
      return {
        error: 'categoria_movida debe intercambiar posiciones consecutivas.',
      };
    }

    return {
      baseEventId: payload.base_event_id.trim(),
      fromOrder: orderChange.from,
      toOrder: orderChange.to,
      displacedCategoryId: displaced.category_id.trim(),
      displacedBaseEventId: displaced.base_event_id.trim(),
      displacedBaseVersion,
      displacedBaseServerSequence,
      displacedFromOrder: displacedOrderChange.from,
      displacedToOrder: displacedOrderChange.to,
    };
  }

  static parseCategoriaActualizadaPayload(
    payload: Record<string, unknown>,
  ): CategoriaActualizadaPayload | { error: string } {
    if (
      typeof payload.base_event_id !== 'string' ||
      payload.base_event_id.trim() === ''
    ) {
      return { error: 'payload.base_event_id es obligatorio.' };
    }
    if (
      !Array.isArray(payload.changed_fields) ||
      payload.changed_fields.length === 0
    ) {
      return { error: 'payload.changed_fields es obligatorio.' };
    }

    const changedFields: CategoriaMutableField[] = [];
    for (const field of payload.changed_fields) {
      if (
        typeof field !== 'string' ||
        !CATEGORY_MUTABLE_FIELDS.has(field as CategoriaMutableField) ||
        changedFields.includes(field as CategoriaMutableField)
      ) {
        return { error: 'payload.changed_fields contiene campos inválidos.' };
      }
      changedFields.push(field as CategoriaMutableField);
    }

    if (!this.isRecord(payload.changes)) {
      return { error: 'payload.changes es obligatorio.' };
    }

    let name: CategoriaFieldChange<string> | null = null;
    let colorKey: CategoriaFieldChange<string> | null = null;

    if (changedFields.includes('name')) {
      const change = this.readStringChange(payload.changes, 'name');
      if ('error' in change) return change;
      const from = change.from.trim();
      const to = change.to.trim();
      if (!from || !to) {
        return { error: 'changes.name.from y to son obligatorios.' };
      }
      if (from === to) {
        return { error: 'changes.name debe modificar el valor.' };
      }
      name = { from, to };
    }

    if (changedFields.includes('color_key')) {
      const change = this.readStringChange(payload.changes, 'color_key');
      if ('error' in change) return change;
      if (
        !CATEGORY_COLOR_KEYS.has(change.from) ||
        !CATEGORY_COLOR_KEYS.has(change.to)
      ) {
        return {
          error:
            'changes.color_key.from y to deben pertenecer a la paleta permitida.',
        };
      }
      if (change.from === change.to) {
        return { error: 'changes.color_key debe modificar el valor.' };
      }
      colorKey = change;
    }

    return {
      baseEventId: payload.base_event_id.trim(),
      changedFields,
      name,
      colorKey,
    };
  }

  private static readStringChange(
    changes: Record<string, unknown>,
    field: CategoriaMutableField,
  ): CategoriaFieldChange<string> | { error: string } {
    const change = changes[field];
    if (
      !this.isRecord(change) ||
      typeof change.from !== 'string' ||
      typeof change.to !== 'string'
    ) {
      return { error: `changes.${field}.from y to son obligatorios.` };
    }
    return { from: change.from, to: change.to };
  }

  private static readIntegerChange(
    source: Record<string, unknown>,
    field: string,
  ): CategoriaFieldChange<number> | { error: string } {
    const change = source[field];
    if (!this.isRecord(change)) {
      return { error: `${field}.from y to son obligatorios.` };
    }
    const from = this.readNonNegativeInteger(change.from);
    const to = this.readNonNegativeInteger(change.to);
    if (from === null || to === null || from === to) {
      return {
        error: `${field}.from y to deben ser enteros >= 0 diferentes.`,
      };
    }
    return { from, to };
  }

  private static readNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0
      ? value
      : null;
  }

  private static readPositiveInteger(value: unknown): number | null {
    const parsed = this.readNonNegativeInteger(value);
    return parsed !== null && parsed >= 1 ? parsed : null;
  }

  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  static toNullableNumber(
    value: string | number | null | undefined,
  ): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
}
