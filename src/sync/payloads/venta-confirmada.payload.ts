import { requiredRecord, requiredUuidV4 } from './inventory-movement.payload';

export interface SaleSnapshot {
  variant_id: string;
  product_name_snapshot: string;
  variant_name_snapshot: string | null;
  sale_mode_snapshot: 'unit' | 'measured';
  quantity: number | null;
  measured_quantity_atomic: number | null;
  unit_price_minor: number;
  standard_cost_minor_snapshot: number | null;
  price_reference_quantity_atomic_snapshot: number | null;
  sale_unit_code_snapshot: string | null;
  sale_unit_symbol_snapshot: string | null;
  sale_unit_atomic_factor_snapshot: number | null;
}
export interface SaleConsumption {
  inventory_item_id: string;
  component_atomic: number;
  quantity_delta_atomic: number;
  movement_id: string | null;
  movement_type: 'sale_consumption';
  total_cost_minor: null;
}
export interface ConfirmedSaleLine {
  sale_item_id: string;
  product_id: string;
  configuration_event_id: string;
  snapshot: SaleSnapshot;
  consumption_mode: 'none' | 'direct' | 'recipe';
  sale_unit_id: string | null;
  consumptions: SaleConsumption[];
}
export function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new Error('Entero fuera de rango.');
  return value;
}
export function rounded(
  component: number,
  quantity: number,
  reference: number,
): number {
  const n = BigInt(component) * BigInt(quantity),
    d = BigInt(reference);
  const result = (2n * n + d) / (2n * d);
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Importe o consumo fuera de rango.');
  return Number(result);
}
export function lineTotal(s: SaleSnapshot): number {
  return rounded(
    s.unit_price_minor,
    s.quantity ?? s.measured_quantity_atomic!,
    s.price_reference_quantity_atomic_snapshot ?? 1,
  );
}
function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 500)
    throw new Error('Texto inválido.');
  return v;
}
function nullableText(v: unknown): string | null {
  return v == null ? null : text(v);
}
function optionalInteger(v: unknown, min = 0): number | null {
  return v == null ? null : integer(v, min);
}
function parseLine(value: unknown): ConfirmedSaleLine {
  const l = requiredRecord(value, 'line'),
    s = requiredRecord(l.snapshot, 'snapshot');
  const snapshot: SaleSnapshot = {
    variant_id: requiredUuidV4(s.variant_id, 'variant_id'),
    product_name_snapshot: text(s.product_name_snapshot),
    variant_name_snapshot: nullableText(s.variant_name_snapshot),
    sale_mode_snapshot:
      s.sale_mode_snapshot as SaleSnapshot['sale_mode_snapshot'],
    quantity: optionalInteger(s.quantity, 1),
    measured_quantity_atomic: optionalInteger(s.measured_quantity_atomic, 1),
    unit_price_minor: integer(s.unit_price_minor, 1),
    standard_cost_minor_snapshot: optionalInteger(
      s.standard_cost_minor_snapshot,
    ),
    price_reference_quantity_atomic_snapshot: optionalInteger(
      s.price_reference_quantity_atomic_snapshot,
      1,
    ),
    sale_unit_code_snapshot: nullableText(s.sale_unit_code_snapshot),
    sale_unit_symbol_snapshot: nullableText(s.sale_unit_symbol_snapshot),
    sale_unit_atomic_factor_snapshot: optionalInteger(
      s.sale_unit_atomic_factor_snapshot,
      1,
    ),
  };
  const measured = snapshot.sale_mode_snapshot === 'measured';
  if (
    (!measured && snapshot.sale_mode_snapshot !== 'unit') ||
    (measured
      ? snapshot.quantity !== null ||
        snapshot.measured_quantity_atomic === null ||
        snapshot.price_reference_quantity_atomic_snapshot === null ||
        snapshot.sale_unit_code_snapshot === null ||
        snapshot.sale_unit_symbol_snapshot === null ||
        snapshot.sale_unit_atomic_factor_snapshot === null
      : snapshot.quantity === null ||
        snapshot.measured_quantity_atomic !== null ||
        snapshot.price_reference_quantity_atomic_snapshot !== null ||
        snapshot.sale_unit_code_snapshot !== null ||
        snapshot.sale_unit_symbol_snapshot !== null ||
        snapshot.sale_unit_atomic_factor_snapshot !== null)
  )
    throw new Error('Medida inválida.');
  const saleUnitId =
    l.sale_unit_id == null
      ? null
      : requiredUuidV4(l.sale_unit_id, 'sale_unit_id');
  if (measured !== (saleUnitId !== null)) throw new Error('Unidad inválida.');
  const mode = l.consumption_mode;
  if (mode !== 'none' && mode !== 'direct' && mode !== 'recipe')
    throw new Error('Modo de consumo inválido.');
  if (!Array.isArray(l.consumptions)) throw new Error('Consumos requeridos.');
  const consumptions: SaleConsumption[] = l.consumptions.map((raw) => {
    const c = requiredRecord(raw, 'consumption');
    const component = integer(c.component_atomic, 1);
    const expected = rounded(
      component,
      snapshot.quantity ?? snapshot.measured_quantity_atomic!,
      mode === 'recipe'
        ? (snapshot.price_reference_quantity_atomic_snapshot ?? 1)
        : 1,
    );
    if (
      c.quantity_delta_atomic !== -expected ||
      c.movement_type !== 'sale_consumption' ||
      c.total_cost_minor != null ||
      (expected === 0) !== (c.movement_id === null)
    )
      throw new Error('Delta de consumo inconsistente.');
    return {
      inventory_item_id: requiredUuidV4(
        c.inventory_item_id,
        'inventory_item_id',
      ),
      component_atomic: component,
      quantity_delta_atomic: -expected,
      movement_id:
        expected === 0 ? null : requiredUuidV4(c.movement_id, 'movement_id'),
      movement_type: 'sale_consumption',
      total_cost_minor: null,
    };
  });
  if (
    (mode === 'none' && consumptions.length !== 0) ||
    (mode === 'direct' &&
      (consumptions.length !== 1 || consumptions[0].component_atomic !== 1)) ||
    (mode === 'recipe' && !consumptions.length) ||
    new Set(consumptions.map((c) => c.inventory_item_id)).size !==
      consumptions.length
  )
    throw new Error('Configuración inconsistente.');
  return {
    sale_item_id: requiredUuidV4(l.sale_item_id, 'sale_item_id'),
    product_id: requiredUuidV4(l.product_id, 'product_id'),
    configuration_event_id: requiredUuidV4(
      l.configuration_event_id,
      'configuration_event_id',
    ),
    snapshot,
    consumption_mode: mode,
    sale_unit_id: saleUnitId,
    consumptions,
  };
}
export class VentaConfirmadaPayload {
  static readonly aggregateType = 'sale';
  static readonly eventType = 'venta_confirmada';
  private constructor(
    readonly paymentId: string | null,
    readonly totalMinor: number,
    readonly receivedMinor: number,
    readonly changeMinor: number,
    readonly lines: ConfirmedSaleLine[],
    readonly dependencyEventIds: string[],
    readonly paymentMethod: string,
    readonly clienteId: string | null,
    readonly clienteEventId: string | null,
    readonly clienteNombre: string | null,
    readonly occurredAtMs: number | null,
    readonly paymentReference: string | null,
  ) {}
  static fromJson(j: Record<string, unknown>): VentaConfirmadaPayload {
    if (
      !['cash', 'credit', 'transfer'].includes(j.payment_method as string) ||
      j.currency !== 'MXN' ||
      !Array.isArray(j.lines) ||
      !j.lines.length ||
      !Array.isArray(j.dependency_event_ids)
    )
      throw new Error('Venta inválida.');
    const credit = j.payment_method === 'credit';
    if (j.payment_reference != null && typeof j.payment_reference !== 'string')
      throw new Error('Referencia inválida.');
    const reference = j.payment_reference?.trim() || null;
    if (reference != null && reference.length > 500)
      throw new Error('La referencia admite hasta 500 caracteres.');
    if (
      credit &&
      (!Number.isSafeInteger(j.occurred_at_ms) ||
        (j.occurred_at_ms as number) <= 0)
    )
      throw new Error('Fecha del crédito inválida.');
    const clienteId =
      j.cliente_id == null ? null : requiredUuidV4(j.cliente_id, 'cliente_id');
    const clienteEventId =
      j.cliente_event_id == null
        ? null
        : requiredUuidV4(j.cliente_event_id, 'cliente_event_id');
    const clienteNombre = j.cliente_nombre == null ? null : j.cliente_nombre;
    if (
      (clienteId &&
        (!clienteEventId ||
          typeof clienteNombre !== 'string' ||
          !clienteNombre.trim())) ||
      (!clienteId && (clienteEventId || clienteNombre != null)) ||
      (credit && (!clienteId || j.payment_id != null))
    ) {
      throw new Error('Cliente o crédito inválido.');
    }
    const lines = j.lines.map(parseLine);
    const dependencies = j.dependency_event_ids.map((v) =>
      requiredUuidV4(v, 'dependency'),
    );
    const total = integer(j.total_minor),
      received = integer(j.received_minor),
      change = integer(j.change_minor);
    const sum = lines.reduce((n, l) => n + BigInt(lineTotal(l.snapshot)), 0n);
    const movements = lines.flatMap((l) =>
      l.consumptions.flatMap((c) => (c.movement_id ? [c.movement_id] : [])),
    );
    if (
      sum !== BigInt(total) ||
      (j.payment_method === 'transfer' &&
        (received !== total || change !== 0)) ||
      (credit
        ? total <= 0 || received !== 0 || change !== 0
        : received < total || change !== received - total) ||
      (clienteEventId != null && !dependencies.includes(clienteEventId)) ||
      new Set(lines.map((l) => l.sale_item_id)).size !== lines.length ||
      new Set(movements).size !== movements.length ||
      !lines.every((l) => dependencies.includes(l.configuration_event_id))
    )
      throw new Error('Total, pago o identidades inconsistentes.');
    return new VentaConfirmadaPayload(
      credit ? null : requiredUuidV4(j.payment_id, 'payment_id'),
      total,
      received,
      change,
      lines,
      dependencies,
      j.payment_method as string,
      clienteId,
      clienteEventId,
      clienteNombre as string | null,
      credit ? (j.occurred_at_ms as number) : null,
      reference,
    );
  }
  toJson(): Record<string, unknown> {
    return {
      payment_id: this.paymentId,
      payment_method: this.paymentMethod,
      ...(this.paymentReference != null
        ? { payment_reference: this.paymentReference }
        : {}),
      ...(this.occurredAtMs != null
        ? { occurred_at_ms: this.occurredAtMs }
        : {}),
      ...(this.clienteId
        ? {
            cliente_id: this.clienteId,
            cliente_event_id: this.clienteEventId,
            cliente_nombre: this.clienteNombre,
          }
        : {}),
      currency: 'MXN',
      total_minor: this.totalMinor,
      received_minor: this.receivedMinor,
      change_minor: this.changeMinor,
      lines: this.lines,
      dependency_event_ids: this.dependencyEventIds,
    };
  }
}
