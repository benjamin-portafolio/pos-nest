import { normalizeRequiredText } from './inventory-movement.payload';

const DIRECTIONS = new Set(['in', 'out']);
const NATURES = new Set([
  'operating',
  'capital',
  'asset_purchase',
  'inventory_purchase',
  'financing',
]);
const OUT_ONLY_NATURES = new Set(['asset_purchase', 'inventory_purchase']);

/**
 * Payload tipado de `categoria_financiera_creada` (contrato §5.1). La categoría
 * se crea vacía en el dispositivo: sin siembra ni catálogo previo. `name` se
 * normaliza NFKC+trim (1..100 code points); `direction` y `nature` son
 * explícitas e inmutables desde el alta, nunca inferidas del nombre.
 */
export class CategoriaFinancieraCreadaPayload {
  static readonly aggregateType = 'financial_category';
  static readonly eventType = 'categoria_financiera_creada';

  private constructor(
    readonly name: string,
    readonly direction: string,
    readonly nature: string,
  ) {}

  static fromJson(
    value: Record<string, unknown>,
  ): CategoriaFinancieraCreadaPayload {
    const name = categoriaFinancieraName(value.name);
    const direction = financialDirection(value.direction);
    const nature = financialNature(value.nature);
    if (direction === 'in' && OUT_ONLY_NATURES.has(nature)) {
      throw new Error('nature no es compatible con la dirección.');
    }

    return new CategoriaFinancieraCreadaPayload(name, direction, nature);
  }

  toJson(): Record<string, unknown> {
    return {
      name: this.name,
      direction: this.direction,
      nature: this.nature,
    };
  }
}

export function categoriaFinancieraName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('El nombre de la categoría financiera es obligatorio.');
  }

  const normalized = value.normalize('NFKC').trim();
  if (normalized.length === 0) {
    throw new Error('El nombre de la categoría financiera es obligatorio.');
  }

  const length = [...normalized].length;
  if (length > 100) {
    throw new Error('name debe tener entre 1 y 100 caracteres.');
  }

  return normalized;
}

export function financialDirection(value: unknown): string {
  if (typeof value !== 'string' || !DIRECTIONS.has(value)) {
    throw new Error('direction debe ser in u out.');
  }

  return value;
}

export function financialNature(value: unknown): string {
  if (typeof value !== 'string' || !NATURES.has(value)) {
    throw new Error('nature no está permitida.');
  }

  return value;
}

export function financialNotes(value: unknown, fieldName: string): string {
  return normalizeRequiredText(value, fieldName, 100);
}
