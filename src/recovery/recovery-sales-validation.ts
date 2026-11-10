import { EntityManager } from 'typeorm';
import {
  VentaConfirmadaPayload,
  lineTotal,
} from '../sync/payloads/venta-confirmada.payload';
import { ConfirmedSaleHistory } from '../sync/payloads/confirmed-sale-history';
import { SaleAdjustmentRules } from '../sync/payloads/sale-adjustment-rules';
import {
  SaleAdjustmentPayloadData,
  parseSaleAdjustmentPayload,
} from '../sync/payloads/sale-adjustment-data';
import {
  recoveryAssert as check,
  recoveryCompare as compare,
  recoveryEvent as event,
  recoveryHistory as history,
  recoveryMetadata as metadata,
} from './recovery-business-validation';

export async function validateRecoverySales(m: EntityManager) {
  for await (const e of history(m, "event_type='venta_confirmada'", [])) {
    const id = e.aggregate_id,
      p = VentaConfirmadaPayload.fromJson(e.payload);
    check(
      e.base_version === 1 && e.base_server_sequence === null,
      'sales',
      id,
      'initial_version',
    );
    for (const dependency of p.dependencyEventIds)
      await event(m, dependency, e);
    if (p.clienteId) {
      const [customer] = await m.query(
        'SELECT created_event_id FROM clientes WHERE cliente_id=$1',
        [p.clienteId],
      );
      check(
        customer?.created_event_id === p.clienteEventId,
        'sales',
        id,
        'historical_customer',
      );
      await event(m, p.clienteEventId!, e);
    }
    const [sale] = await m.query('SELECT * FROM sales WHERE sale_id=$1', [id]);
    compare(
      sale,
      {
        ...metadata(e),
        status: 'confirmada',
        user_id: e.user_id,
        device_id: e.device_id,
        cliente_id: p.clienteId,
        total_minor: String(p.totalMinor),
        currency: 'MXN',
        pricing_contract_version: p.pricingContractVersion,
        pricing_mode: p.pricingMode,
      },
      'sales',
      id,
    );
    check(
      new Date(sale.created_at_local).getTime() <=
        new Date(e.created_at_local).getTime(),
      'sales',
      id,
      'draft_created_after_confirmation',
    );
    const [local] = await m.query(
      "SELECT row_data FROM recovery_rows WHERE recovery_id=$1 AND entity='sale_presentation_metadata' AND row_data->>'sale_id'=$2",
      [await recoveryId(m), id],
    );
    check(
      local &&
        new Date(local.row_data.created_at_local).getTime() ===
          new Date(sale.created_at_local).getTime() &&
        new Date(local.row_data.updated_at_local).getTime() >=
          new Date(sale.created_at_local).getTime(),
      'sales',
      id,
      'presentation_provenance',
    );
    for (const [index, line] of p.lines.entries()) {
      check(
        !(await ConfirmedSaleHistory.validateHistory(m, line)) &&
          !(await ConfirmedSaleHistory.validatePriceHistory(m, line)),
        'sale_items',
        line.sale_item_id,
        'historical_configuration',
      );
      const [row] = await m.query(
        'SELECT * FROM sale_items WHERE sale_item_id=$1',
        [line.sale_item_id],
      );
      compare(
        row,
        {
          ...metadata(e),
          sale_id: id,
          variant_id: line.snapshot.variant_id,
          total_minor: String(lineTotal(line.snapshot)),
          sort_order: index,
        },
        'sale_items',
        line.sale_item_id,
      );
      const normalized = (l: any) => ({
        ...l,
        snapshot: {
          ...l.snapshot,
          consumption_configuration_key:
            l.snapshot.consumption_configuration_key ?? null,
        },
      });
      compare(
        { snapshot: normalized(row.snapshot) },
        { snapshot: normalized(line) },
        'sale_items',
        line.sale_item_id,
      );
      for (const c of line.consumptions)
        if (c.movement_id) {
          const [movement] = await m.query(
            'SELECT * FROM inventory_movements WHERE movement_id=$1',
            [c.movement_id],
          );
          compare(
            movement,
            {
              movement_id: c.movement_id,
              inventory_item_id: c.inventory_item_id,
              sale_item_id: line.sale_item_id,
              sale_adjustment_id: null,
              event_id: e.event_id,
              reversal_of_movement_id: null,
              movement_type: 'sale_consumption',
              quantity_delta_atomic: String(c.quantity_delta_atomic),
              total_cost_minor: null,
              reason: null,
              server_sequence: String(e.server_sequence),
            },
            'inventory_movements',
            c.movement_id,
          );
          check(
            new Date(movement.created_at_local).getTime() ===
              new Date(e.created_at_local).getTime(),
            'inventory_movements',
            c.movement_id,
            'original_date',
          );
        }
    }
    const [lineCount] = await m.query(
      'SELECT count(*)::int AS n FROM sale_items WHERE sale_id=$1',
      [id],
    );
    check(lineCount.n === p.lines.length, 'sale_items', id, 'exact_set');
    const payments = await m.query(
        'SELECT * FROM sale_payments WHERE sale_id=$1',
        [id],
      ),
      credits = await m.query('SELECT * FROM credit_sales WHERE sale_id=$1', [
        id,
      ]);
    if (p.paymentMethod === 'credit') {
      check(
        payments.length === 0 && credits.length === 1,
        'credit_sales',
        id,
        'payment_kind',
      );
      compare(
        credits[0],
        {
          ...metadata(e),
          id,
          sale_id: id,
          cliente_id: p.clienteId,
          amount_minor: String(p.totalMinor),
          occurred_at_ms: String(p.occurredAtMs),
        },
        'credit_sales',
        id,
      );
    } else {
      check(
        credits.length === 0 && payments.length === 1,
        'sale_payments',
        id,
        'payment_kind',
      );
      compare(
        payments[0],
        {
          ...metadata(e),
          payment_id: p.paymentId,
          sale_id: id,
          method: p.paymentMethod,
          currency: 'MXN',
          reference: p.paymentReference,
          amount_minor: String(p.totalMinor),
          received_minor: String(p.receivedMinor),
          change_minor: String(p.changeMinor),
        },
        'sale_payments',
        p.paymentId!,
      );
    }
    const documents = await m.query(
      'SELECT * FROM sale_adjustments WHERE sale_id=$1 ORDER BY revision',
      [id],
    );
    const prior: SaleAdjustmentPayloadData[] = [];
    for (const doc of documents) {
      const original = await event(m, doc.event_id),
        a = parseSaleAdjustmentPayload(original.payload);
      check(
        a.event_id === original.event_id &&
          original.aggregate_id === id &&
          original.base_version === a.expected_revision + 1 &&
          new Date(original.created_at_local).getTime() ===
            Math.floor(a.occurred_at_ms / 1000) * 1000,
        'sale_adjustments',
        doc.id,
        'envelope',
      );
      for (const dependency of a.dependency_event_ids)
        await event(m, dependency, original);
      const base = await event(
        m,
        prior.at(-1)?.event_id ?? e.event_id,
        original,
      );
      check(
        String(original.base_server_sequence) === String(base.server_sequence),
        'sale_adjustments',
        doc.id,
        'official_base',
      );
      try {
        SaleAdjustmentRules.validate(a, p, e.event_id, id, prior);
      } catch (error) {
        check(
          false,
          'sale_adjustments',
          doc.id,
          'historical_rules: ' + (error as Error).message,
        );
      }
      compare(
        doc,
        {
          ...metadata(original),
          id: a.operation_id,
          event_id: a.event_id,
          sale_id: id,
          revision: a.expected_revision + 1,
          kind: a.kind,
          reason: a.reason,
          total_minor: String(a.total_minor),
          occurred_at_ms: String(a.occurred_at_ms),
          utc_offset_minutes: a.utc_offset_minutes,
          business_date: a.business_date,
          currency: a.currency,
          method: a.settlement.method,
          settlement_action: a.settlement.action,
          reference: a.settlement.reference,
          payment_id: a.settlement.payment_id,
          cliente_id: a.settlement.cliente_id,
        },
        'sale_adjustments',
        a.operation_id,
      );
      const lines = await m.query(
        'SELECT * FROM sale_adjustment_lines WHERE operation_id=$1 ORDER BY sale_item_id',
        [a.operation_id],
      );
      check(
        lines.length === a.lines.length,
        'sale_adjustment_lines',
        a.operation_id,
        'exact_set',
      );
      for (const l of a.lines) {
        compare(
          lines.find((x) => x.sale_item_id === l.sale_item_id),
          {
            quantity_atomic: String(l.quantity_atomic),
            amount_minor: String(l.amount_minor),
            recovered_cost_minor:
              l.recovered_cost_minor === null
                ? null
                : String(l.recovered_cost_minor),
            destination: l.destination,
            reason: l.reason,
          },
          'sale_adjustment_lines',
          l.sale_item_id,
        );
        for (const stock of l.stock) {
          const [movement] = await m.query(
            'SELECT * FROM inventory_movements WHERE movement_id=$1',
            [stock.movement_id],
          );
          compare(
            movement,
            {
              inventory_item_id: stock.inventory_item_id,
              sale_item_id: l.sale_item_id,
              sale_adjustment_id: a.operation_id,
              event_id: a.event_id,
              reversal_of_movement_id: stock.original_movement_id,
              movement_type:
                a.kind === 'void' ? 'sale_void_restock' : 'sale_return_restock',
              quantity_delta_atomic: String(stock.quantity_atomic),
              total_cost_minor: null,
              reason: null,
              server_sequence: String(original.server_sequence),
            },
            'inventory_movements',
            stock.movement_id,
          );
          check(
            new Date(movement.created_at_local).getTime() ===
              new Date(original.created_at_local).getTime(),
            'inventory_movements',
            stock.movement_id,
            'original_date',
          );
        }
      }
      const reductions = await m.query(
        'SELECT * FROM sale_credit_reductions WHERE operation_id=$1',
        [a.operation_id],
      );
      if (a.settlement.method === 'credit' && a.total_minor > 0) {
        check(
          reductions.length === 1,
          'sale_credit_reductions',
          a.operation_id,
          'exact_set',
        );
        compare(
          reductions[0],
          { credit_id: id, amount_minor: String(a.total_minor) },
          'sale_credit_reductions',
          a.operation_id,
        );
      } else
        check(
          !reductions.length,
          'sale_credit_reductions',
          a.operation_id,
          'unexpected_reduction',
        );
      prior.push(a);
    }
  }
  for (const [table, id, creation] of [
    ['sales', 'sale_id', 'venta_confirmada'],
    ['sale_items', 'sale_item_id', 'venta_confirmada'],
    ['sale_payments', 'payment_id', 'venta_confirmada'],
    ['credit_sales', 'id', 'venta_confirmada'],
    ['sale_adjustments', 'id', null],
  ] as const) {
    const [bad] = await m.query(
      `SELECT p."${id}" AS id FROM "${table}" p LEFT JOIN events e ON e.event_id=p.created_event_id WHERE e.sync_status IS DISTINCT FROM 'synced' OR ($1::text IS NOT NULL AND e.event_type<>$1) OR ($1::text IS NULL AND e.event_type NOT IN ('venta_anulada','devolucion_venta_registrada')) LIMIT 1`,
      [creation],
    );
    check(!bad, table, bad?.id, 'creator_missing');
  }
  const [unrepresented] = await m.query(
    "SELECT e.event_id FROM events e LEFT JOIN sale_adjustments a ON a.event_id=e.event_id WHERE e.sync_status='synced' AND e.event_type IN ('venta_anulada','devolucion_venta_registrada') AND a.id IS NULL LIMIT 1",
  );
  check(
    !unrepresented,
    'sale_adjustments',
    unrepresented?.event_id,
    'missing_projection',
  );
}
async function recoveryId(m: EntityManager) {
  return (
    await m.query('SELECT active_recovery_id FROM server_state WHERE singleton')
  )[0].active_recovery_id;
}
