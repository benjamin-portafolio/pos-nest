import { requiredUuidV4 } from './inventory-movement.payload';
import { CashBindingPayload } from './cash-binding.payload';
export function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw new Error('Objeto de ajuste inválido.');
  return v as Record<string, unknown>;
}
export function number(v: unknown, min = 0): number {
  if (
    typeof v !== 'number' ||
    !Number.isSafeInteger(v) ||
    v < min ||
    v > Number.MAX_SAFE_INTEGER
  )
    throw new Error('Entero fuera de rango.');
  return v;
}
export function id(v: unknown): string {
  return requiredUuidV4(v, 'adjustment_id');
}
export function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 500)
    throw new Error('Texto requerido.');
  return v.trim();
}
function choice(v: unknown, choices: string[]): string {
  if (typeof v !== 'string' || !choices.includes(v))
    throw new Error('Opción inválida.');
  return v;
}
export function list<T>(v: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Error('Lista requerida.');
  return v.map(parse);
}
function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('Boolean requerido.');
  return v;
}
function offset(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > 840)
    throw new Error('Offset inválido.');
  return v;
}
export interface SaleAdjustmentStockData {
  readonly movement_id: string;
  readonly original_movement_id: string;
  readonly inventory_item_id: string;
  readonly quantity_atomic: number;
}
export function parseSaleAdjustmentStock(
  value: unknown,
): SaleAdjustmentStockData {
  const j = object(value, [
    'movement_id',
    'original_movement_id',
    'inventory_item_id',
    'quantity_atomic',
  ]);
  return {
    movement_id: id(j.movement_id),
    original_movement_id: id(j.original_movement_id),
    inventory_item_id: id(j.inventory_item_id),
    quantity_atomic: number(j.quantity_atomic, 1),
  };
}
export interface SaleAdjustmentLineData {
  readonly sale_item_id: string;
  readonly quantity_atomic: number;
  readonly destination: string;
  readonly reason: string | null;
  readonly amount_minor: number;
  readonly recovered_cost_minor: number | null;
  readonly stock: SaleAdjustmentStockData[];
}
export function parseSaleAdjustmentLine(
  value: unknown,
): SaleAdjustmentLineData {
  const j = object(value, [
    'sale_item_id',
    'quantity_atomic',
    'destination',
    'reason',
    'amount_minor',
    'recovered_cost_minor',
    'stock',
  ]);
  return {
    sale_item_id: id(j.sale_item_id),
    quantity_atomic: number(j.quantity_atomic, 1),
    destination: choice(j.destination, [
      'restock',
      'not_restockable',
      'untracked',
      'void',
    ]),
    reason: j.reason === null ? null : text(j.reason),
    amount_minor: number(j.amount_minor),
    recovered_cost_minor:
      j.recovered_cost_minor === null ? null : number(j.recovered_cost_minor),
    stock: list(j.stock, parseSaleAdjustmentStock),
  };
}
export interface SaleAdjustmentSettlementData {
  readonly method: string;
  readonly payment_id: string | null;
  readonly cliente_id: string | null;
  readonly action: string;
  readonly reference: string | null;
  readonly cash_enabled: boolean;
  readonly cash: Record<string, unknown> | null;
}
export function parseSaleAdjustmentSettlement(
  value: unknown,
): SaleAdjustmentSettlementData {
  const j = object(value, [
    'method',
    'payment_id',
    'cliente_id',
    'action',
    'reference',
    'cash_enabled',
    'cash',
  ]);
  return {
    method: choice(j.method, ['cash', 'transfer', 'credit']),
    payment_id: j.payment_id === null ? null : id(j.payment_id),
    cliente_id: j.cliente_id === null ? null : id(j.cliente_id),
    action: choice(j.action, [
      'refund_completed',
      'unreceived_correction',
      'credit_reduction',
      'no_money',
    ]),
    reference: j.reference === null ? null : text(j.reference),
    cash_enabled: bool(j.cash_enabled),
    cash:
      j.cash === null
        ? null
        : CashBindingPayload.optional(
            object(j.cash, ['session_id', 'opening_event_id', 'movement_id']),
            'cash',
            1,
          )!.toJson(),
  };
}
export interface SaleAdjustmentPayloadData {
  readonly schema_version: number;
  readonly kind: string;
  readonly operation_id: string;
  readonly event_id: string;
  readonly sale_id: string;
  readonly confirmation_event_id: string;
  readonly expected_revision: number;
  readonly previous_adjustment_event_id: string | null;
  readonly occurred_at_ms: number;
  readonly utc_offset_minutes: number;
  readonly business_date: string;
  readonly reason: string;
  readonly currency: string;
  readonly total_minor: number;
  readonly settlement: SaleAdjustmentSettlementData;
  readonly lines: SaleAdjustmentLineData[];
  readonly dependency_event_ids: string[];
}
export function parseSaleAdjustmentPayload(
  value: unknown,
): SaleAdjustmentPayloadData {
  const j = object(value, [
    'schema_version',
    'kind',
    'operation_id',
    'event_id',
    'sale_id',
    'confirmation_event_id',
    'expected_revision',
    'previous_adjustment_event_id',
    'occurred_at_ms',
    'utc_offset_minutes',
    'business_date',
    'reason',
    'currency',
    'total_minor',
    'settlement',
    'lines',
    'dependency_event_ids',
  ]);
  return {
    schema_version: number(j.schema_version, 1),
    kind: choice(j.kind, ['void', 'return']),
    operation_id: id(j.operation_id),
    event_id: id(j.event_id),
    sale_id: id(j.sale_id),
    confirmation_event_id: id(j.confirmation_event_id),
    expected_revision: number(j.expected_revision),
    previous_adjustment_event_id:
      j.previous_adjustment_event_id === null
        ? null
        : id(j.previous_adjustment_event_id),
    occurred_at_ms: number(j.occurred_at_ms, 1),
    utc_offset_minutes: offset(j.utc_offset_minutes),
    business_date: text(j.business_date),
    reason: text(j.reason),
    currency: choice(j.currency, ['MXN']),
    total_minor: number(j.total_minor),
    settlement: parseSaleAdjustmentSettlement(j.settlement),
    lines: list(j.lines, parseSaleAdjustmentLine),
    dependency_event_ids: list(j.dependency_event_ids, id),
  };
}

export function businessDate(
  occurredAtMs: number,
  utcOffsetMinutes: number,
  date: string,
): void {
  if (
    occurredAtMs <= 0 ||
    occurredAtMs > 253402249199999 ||
    new Date(occurredAtMs + utcOffsetMinutes * 60000)
      .toISOString()
      .slice(0, 10) !== date
  )
    throw new Error('Fecha de negocio inconsistente.');
}
