import { SaleAdjustmentPayloadData as Adjustment } from './sale-adjustment-data';
import {
  VentaConfirmadaPayload,
  lineTotal,
  rounded,
} from './venta-confirmada.payload';
export interface AdjustmentRef {
  ref_type: string;
  ref_id: string;
  relationship: 'affects' | 'uses';
}
export class SaleAdjustmentRules {
  static cumulative(total: number, quantity: number, original: number): number {
    if (
      ![total, quantity, original].every(Number.isSafeInteger) ||
      total < 0 ||
      original <= 0 ||
      quantity < 0 ||
      quantity > original
    )
      throw new Error('Acumulado fuera de rango.');
    return Number(
      (2n * BigInt(total) * BigInt(quantity) + BigInt(original)) /
        (2n * BigInt(original)),
    );
  }
  static validate(
    p: Adjustment,
    original: VentaConfirmadaPayload,
    confirmationEventId: string,
    saleId: string,
    history: Adjustment[],
  ): void {
    for (let i = 0; i < history.length; i++)
      this.validateOne(
        history[i],
        original,
        confirmationEventId,
        saleId,
        history.slice(0, i),
      );
    this.validateOne(p, original, confirmationEventId, saleId, history);
  }
  private static validateOne(
    p: Adjustment,
    original: VentaConfirmadaPayload,
    confirmationEventId: string,
    saleId: string,
    history: Adjustment[],
  ): void {
    if (
      p.schema_version !== 1 ||
      p.sale_id !== saleId ||
      p.confirmation_event_id !== confirmationEventId ||
      p.expected_revision !== history.length ||
      p.previous_adjustment_event_id !== (history.at(-1)?.event_id ?? null) ||
      history.some((h) => h.kind === 'void') ||
      (p.kind === 'void' && history.length > 0) ||
      p.event_id === confirmationEventId ||
      p.event_id === p.operation_id ||
      history.some(
        (h) => h.event_id === p.event_id || h.operation_id === p.operation_id,
      )
    )
      throw new Error('Identidad, estado o revisión obsoleta.');
    const date = new Date(p.occurred_at_ms + p.utc_offset_minutes * 60000);
    if (
      !Number.isFinite(date.getTime()) ||
      date.getUTCFullYear() > 9999 ||
      date.toISOString().slice(0, 10) !== p.business_date ||
      !p.lines.length ||
      new Set(p.lines.map((l) => l.sale_item_id)).size !== p.lines.length ||
      (p.kind === 'void' && p.lines.length !== original.lines.length)
    )
      throw new Error('Fecha o líneas inválidas.');
    const deps = new Set(p.dependency_event_ids);
    const cash = p.settlement.cash;
    const requiredDeps = [
      confirmationEventId,
      ...(p.previous_adjustment_event_id
        ? [p.previous_adjustment_event_id]
        : []),
      ...(cash ? [cash.opening_event_id as string] : []),
    ];
    if (
      deps.size !== p.dependency_event_ids.length ||
      deps.has(p.event_id) ||
      !requiredDeps.every((d) => deps.has(d))
    )
      throw new Error('Dependencias inválidas.');
    let sum = 0n;
    const reservedMovements = new Set([
      ...original.lines.flatMap((l) =>
        l.consumptions.flatMap((c) => (c.movement_id ? [c.movement_id] : [])),
      ),
      ...(original.cash ? [original.cash.movementId] : []),
      ...history.flatMap((h) => [
        ...(h.settlement.cash ? [h.settlement.cash.movement_id as string] : []),
        ...h.lines.flatMap((l) => l.stock.map((m) => m.movement_id)),
      ]),
    ]);
    const movements = new Set<string>();
    for (const l of p.lines) {
      const source = original.lines.find(
        (x) => x.sale_item_id === l.sale_item_id,
      );
      if (!source) throw new Error('Línea ajena.');
      const s = source.snapshot,
        q = s.quantity ?? s.measured_quantity_atomic!;
      const previous = history
        .flatMap((h) => h.lines)
        .filter((x) => x.sale_item_id === l.sale_item_id);
      const returned = previous.reduce(
        (a, x) => a + BigInt(x.quantity_atomic),
        0n,
      );
      const recovered = previous
        .filter((x) => x.destination === 'restock')
        .reduce((a, x) => a + BigInt(x.quantity_atomic), 0n);
      if (
        returned + BigInt(l.quantity_atomic) > BigInt(q) ||
        (p.kind === 'void' &&
          (l.quantity_atomic !== q || l.destination !== 'void')) ||
        (p.kind === 'return' &&
          (l.destination === 'void' ||
            (source.consumption_mode === 'none'
              ? l.destination !== 'untracked'
              : l.destination === 'untracked') ||
            (source.consumption_mode === 'recipe' &&
              l.destination === 'restock'))) ||
        (l.destination === 'not_restockable' && l.reason === null)
      )
        throw new Error('Cantidad o destino inválido.');
      const before = Number(returned),
        recoveryBefore = Number(recovered),
        restore = p.kind === 'void' || l.destination === 'restock';
      const recoveryAfter = recoveryBefore + (restore ? l.quantity_atomic : 0);
      const C = this.cumulative;
      const amount =
        C(lineTotal(s), before + l.quantity_atomic, q) -
        C(lineTotal(s), before, q);
      const historicalCost =
        s.standard_cost_minor_snapshot === null
          ? null
          : rounded(
              s.standard_cost_minor_snapshot,
              q,
              s.price_reference_quantity_atomic_snapshot ?? 1,
            );
      const cost =
        historicalCost === null
          ? null
          : C(historicalCost, recoveryAfter, q) -
            C(historicalCost, recoveryBefore, q);
      if (l.amount_minor !== amount || l.recovered_cost_minor !== cost)
        throw new Error('Importe o costo manipulado.');
      const expected = source.consumptions.filter(
        (c) =>
          restore &&
          c.quantity_delta_atomic !== 0 &&
          C(-c.quantity_delta_atomic, recoveryAfter, q) -
            C(-c.quantity_delta_atomic, recoveryBefore, q) >
            0,
      );
      if (l.stock.length !== expected.length)
        throw new Error('Restitución incompleta.');
      const seen = new Set<string>();
      for (const m of l.stock) {
        const c = expected.find(
          (c) => c.movement_id === m.original_movement_id,
        );
        if (
          !c ||
          seen.has(m.original_movement_id) ||
          movements.has(m.movement_id) ||
          reservedMovements.has(m.movement_id) ||
          m.movement_id === p.event_id ||
          m.movement_id === p.operation_id ||
          history.some((h) =>
            h.lines.some((x) =>
              x.stock.some((s) => s.movement_id === m.movement_id),
            ),
          ) ||
          m.inventory_item_id !== c.inventory_item_id ||
          m.quantity_atomic !==
            C(-c.quantity_delta_atomic, recoveryAfter, q) -
              C(-c.quantity_delta_atomic, recoveryBefore, q)
        )
          throw new Error('Movimiento manipulado.');
        seen.add(m.original_movement_id);
        movements.add(m.movement_id);
      }
      sum += BigInt(amount);
    }
    if (sum !== BigInt(p.total_minor)) throw new Error('Total incorrecto.');
    const t = p.settlement;
    if (
      t.method !== original.paymentMethod ||
      t.payment_id !== original.paymentId ||
      t.cliente_id !== original.clienteId ||
      (t.method === 'credit'
        ? t.action !== 'credit_reduction'
        : p.total_minor === 0
          ? t.action !== 'no_money'
          : !(
              t.action === 'refund_completed' ||
              (p.kind === 'void' && t.action === 'unreceived_correction')
            )) ||
      (t.method === 'transfer' &&
        p.total_minor > 0 &&
        t.action === 'refund_completed' &&
        t.reference === null) ||
      (t.cash_enabled && t.method === 'cash' && p.total_minor > 0) !==
        (cash !== null) ||
      (cash &&
        (movements.has(cash.movement_id as string) ||
          reservedMovements.has(cash.movement_id as string) ||
          cash.movement_id === p.event_id ||
          cash.movement_id === p.operation_id))
    )
      throw new Error('Liquidación inválida.');
  }
  static paidMoneyEffects(p: Adjustment): Record<string, number> {
    return {
      accounting_delta_minor:
        p.settlement.method === 'credit' ? 0 : -p.total_minor,
      physical_cash_delta_minor:
        p.settlement.method === 'cash' &&
        p.settlement.action === 'refund_completed'
          ? -p.total_minor
          : 0,
    };
  }
  static validateCash(
    p: Adjustment,
    enabled: boolean,
    open: boolean,
    sessionId: string | null,
    openingEventId: string | null,
  ): void {
    const t = p.settlement,
      c = t.cash;
    if (
      t.cash_enabled !== enabled ||
      (c &&
        (!open ||
          c.session_id !== sessionId ||
          c.opening_event_id !== openingEventId))
    )
      throw new Error('Se requiere la caja actual abierta.');
  }
  static refs(
    p: Adjustment,
    original: VentaConfirmadaPayload,
  ): AdjustmentRef[] {
    const refs: AdjustmentRef[] = [];
    const add = (
      ref_type: string,
      ref_id: string,
      relationship: 'affects' | 'uses' = 'affects',
    ) => refs.push({ ref_type, ref_id, relationship });
    add('sale', p.sale_id);
    add('sale_adjustment', p.operation_id);
    for (const id of p.dependency_event_ids) add('event', id, 'uses');
    const t = p.settlement;
    if (t.payment_id) add('payment', t.payment_id, 'uses');
    if (t.cliente_id) add('cliente', t.cliente_id, 'uses');
    if (t.method === 'credit') {
      add('credit', p.sale_id);
      add('customer_account', t.cliente_id!);
    }
    if (t.cash) {
      add('cash_session', t.cash.session_id as string, 'uses');
      add('cash_movement', t.cash.movement_id as string);
    }
    for (const l of p.lines) {
      add('sale_item', l.sale_item_id);
      for (const s of original.lines.filter(
        (x) => x.sale_item_id === l.sale_item_id,
      )) {
        add('product', s.product_id, 'uses');
        add('product_variant', s.snapshot.variant_id, 'uses');
        if (s.consumption_mode === 'recipe')
          add('recipe', s.snapshot.variant_id, 'uses');
        if (s.sale_unit_id) add('unit', s.sale_unit_id, 'uses');
        for (const c of s.consumptions)
          add('inventory_item', c.inventory_item_id, 'uses');
      }
      for (const m of l.stock) {
        add('inventory_item', m.inventory_item_id);
        add('inventory_movement', m.original_movement_id, 'uses');
        add('inventory_movement', m.movement_id);
      }
    }
    if (refs.some((r) => !r.ref_id?.trim()))
      throw new Error('Referencias inválidas.');
    return [
      ...new Map(
        refs.map((r) => [`${r.ref_type}/${r.ref_id}/${r.relationship}`, r]),
      ).values(),
    ];
  }
}
