import { CashBindingPayload } from './cash-binding.payload';
import { requiredUuidV4 } from './inventory-movement.payload';
import {
  financialDirection,
  financialNature,
} from './categoria-financiera-creada.payload';
import { normalizeRequiredText } from './inventory-movement.payload';

const METHODS = new Set(['cash', 'transfer']);
/** Máximo entero seguro (9007199254740991), límite superior de importes y fechas. */
export const MAX_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

const CURRENCY = 'MXN';

/**
 * Payload tipado de `movimiento_financiero_registrado` (contrato §5.2). El
 * registro referencia la categoría por `category_id` y su evento de creación
 * por `category_event_id` (dependencia causal, contrato §3.4). `direction` y
 * `nature` se validan como valores permitidos aquí; su coincidencia con la
 * categoría oficial se verifica en el handler (requiere la proyección).
 */
export class MovimientoFinancieroRegistradoPayload {
  static readonly aggregateType = 'financial_entry';
  static readonly eventType = 'movimiento_financiero_registrado';

  private constructor(
    readonly categoryId: string,
    readonly categoryEventId: string,
    readonly categoryNameSnapshot: string,
    readonly direction: string,
    readonly nature: string,
    readonly amountMinor: number,
    readonly method: string,
    readonly occurredAtMs: number,
    readonly notes: string | null,
    readonly reference: string | null,
    readonly cash: CashBindingPayload | null,
  ) {}

  static fromJson(
    value: Record<string, unknown>,
  ): MovimientoFinancieroRegistradoPayload {
    const categoryId = requiredUuidV4(value.category_id, 'category_id');
    const categoryEventId = requiredUuidV4(
      value.category_event_id,
      'category_event_id',
    );
    const categoryNameSnapshot = normalizeRequiredText(
      value.category_name_snapshot,
      'category_name_snapshot',
      100,
    );
    const direction = financialDirection(value.direction);
    const nature = financialNature(value.nature);
    const amountMinor = financialAmountMinor(value.amount_minor);
    financialCurrency(value.currency);
    const method = financialMethod(value.method);
    const occurredAtMs = financialOccurredAtMs(value.occurred_at_ms);
    const notes = financialOptionalText(value.notes, 'notes', 500);
    const reference = financialOptionalText(value.reference, 'reference', 500);

    return new MovimientoFinancieroRegistradoPayload(
      categoryId,
      categoryEventId,
      categoryNameSnapshot,
      direction,
      nature,
      amountMinor,
      method,
      occurredAtMs,
      notes,
      reference,
      CashBindingPayload.optional(value.cash,method,amountMinor),
    );
  }

  toJson(): Record<string, unknown> {
    return {
      ...(this.cash ? {cash:this.cash.toJson()} : {}),
      category_id: this.categoryId,
      category_event_id: this.categoryEventId,
      category_name_snapshot: this.categoryNameSnapshot,
      direction: this.direction,
      nature: this.nature,
      amount_minor: this.amountMinor,
      currency: CURRENCY,
      method: this.method,
      occurred_at_ms: this.occurredAtMs,
      notes: this.notes,
      reference: this.reference,
    };
  }
}

export function financialAmountMinor(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_AMOUNT_MINOR
  ) {
    throw new Error('amount_minor debe ser un entero positivo en centavos.');
  }

  return value;
}

export function financialCurrency(value: unknown): string {
  if (typeof value !== 'string' || value !== CURRENCY) {
    throw new Error('Moneda inválida.');
  }

  return value;
}

export function financialMethod(value: unknown): string {
  if (typeof value !== 'string' || !METHODS.has(value)) {
    throw new Error('method debe ser cash o transfer.');
  }

  return value;
}

export function financialOccurredAtMs(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_AMOUNT_MINOR
  ) {
    throw new Error('occurred_at_ms debe ser un instante válido.');
  }

  return value;
}

/**
 * Texto opcional: null/undefined se conservan; string vacío o solo espacios se
 * normalizan a null (contrato §5.2); el resto se normaliza NFKC+trim con
 * longitud 1..max.
 */
export function financialOptionalText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} debe ser texto.`);
  }
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length === 0) return null;
  const length = [...normalized].length;
  if (length > maxLength) {
    throw new Error(
      `${fieldName} debe tener entre 1 y ${maxLength} caracteres.`,
    );
  }

  return normalized;
}
