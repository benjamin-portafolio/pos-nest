import { EntityManager } from 'typeorm';
import { OperacionVentaConciliadaPayload } from '../sync/payloads/operacion-venta-conciliada.payload';
import {
  parseSaleAdjustmentPayload,
  SaleAdjustmentPayloadData,
} from '../sync/payloads/sale-adjustment-data';
import { SaleAdjustmentRules } from '../sync/payloads/sale-adjustment-rules';
import { VentaConfirmadaPayload } from '../sync/payloads/venta-confirmada.payload';
import { saleReconciliationEvidence } from '../sync/payloads/sale-reconciliation-evidence';
import {
  recoveryAssert as check,
  recoveryCompare as compare,
  recoveryEvent as event,
  recoveryHistory as history,
} from './recovery-business-validation';
import { canonical } from './recovery-contract';

export async function validateRecoveryReconciliations(
  m: EntityManager,
  recoveryId: string,
) {
  const sidecar = async (entity: string, id: string, key = 'id') =>
    (
      await m.query(
        'SELECT row_data FROM recovery_rows WHERE recovery_id=$1 AND entity=$2 AND row_data->>$3=$4',
        [recoveryId, entity, key, id],
      )
    )[0]?.row_data;
  for await (const e of history(
    m,
    "event_type='operacion_venta_conciliada'",
    [],
  )) {
    const contract = OperacionVentaConciliadaPayload.fromJson(e.payload),
      p = contract.data;
    check(
      e.event_id === p.event_id &&
        e.aggregate_id === p.sale_id &&
        e.base_version === p.expected_revision + 1 &&
        new Date(e.created_at_local).getTime() ===
          Math.floor(p.occurred_at_ms / 1000) * 1000,
      'reconciliations',
      p.operation_id,
      'envelope',
    );
    const loser = await event(
      m,
      p.loser_event_id,
      e,
      (
        await m.query('SELECT sync_status FROM events WHERE event_id=$1', [
          p.loser_event_id,
        ])
      )[0]?.sync_status,
    );
    check(
      ['rejected', 'conflict'].includes(loser.sync_status) &&
        loser.aggregate_id === p.sale_id &&
        loser.device_id === e.device_id,
      'reconciliations',
      p.operation_id,
      'loser_identity',
    );
    for (const id of contract.dependencyEventIds()) await event(m, id, e);
    const winner = await event(m, p.winner_event_id, e),
      base = await event(m, p.official_base_event_id, e);
    check(
      winner.aggregate_id === p.sale_id &&
        base.aggregate_id === p.sale_id &&
        String(e.base_server_sequence) === String(base.server_sequence),
      'reconciliations',
      p.operation_id,
      'official_identity',
    );
    const [sale] = await m.query(
      'SELECT created_event_id FROM sales WHERE sale_id=$1',
      [p.sale_id],
    );
    check(sale, 'reconciliations', p.operation_id, 'sale_missing');
    const confirmation = await event(m, sale.created_event_id, e),
      original = VentaConfirmadaPayload.fromJson(confirmation.payload);
    const docs = await m.query(
      'SELECT event_id FROM sale_adjustments WHERE sale_id=$1 AND last_server_sequence<$2 ORDER BY revision',
      [p.sale_id, e.server_sequence],
    );
    check(
      p.expected_revision === docs.length &&
        p.official_base_event_id ===
          (docs.at(-1)?.event_id ?? confirmation.event_id) &&
        (winner.event_id === confirmation.event_id ||
          docs.some((d) => d.event_id === winner.event_id)),
      'reconciliations',
      p.operation_id,
      'official_revision',
    );
    const frozen = parseSaleAdjustmentPayload(loser.payload),
      ancestors: SaleAdjustmentPayloadData[] = [];
    let cursor = frozen.previous_adjustment_event_id;
    const seen = new Set<string>();
    while (cursor) {
      check(
        !seen.has(cursor),
        'reconciliations',
        p.operation_id,
        'history_cycle',
      );
      seen.add(cursor);
      const d = await event(
        m,
        cursor,
        loser,
        (
          await m.query('SELECT sync_status FROM events WHERE event_id=$1', [
            cursor,
          ])
        )[0]?.sync_status,
      );
      check(
        d.aggregate_id === p.sale_id,
        'reconciliations',
        p.operation_id,
        'ancestor_identity',
      );
      const data = parseSaleAdjustmentPayload(d.payload);
      ancestors.unshift(data);
      cursor = data.previous_adjustment_event_id;
    }
    try {
      SaleAdjustmentRules.validate(
        frozen,
        original,
        confirmation.event_id,
        p.sale_id,
        ancestors,
      );
      contract.validateIncident(
        p.loser_event_id,
        p.sale_id,
        loser.event_id,
        winner.event_id,
        base.event_id,
        docs.length,
        saleReconciliationEvidence(frozen),
        false,
      );
    } catch (error) {
      check(
        false,
        'reconciliations',
        p.operation_id,
        'original_evidence: ' + (error as Error).message,
      );
    }
    const [duplicate] = await m.query(
      "SELECT event_id FROM events WHERE event_type='operacion_venta_conciliada' AND sync_status='synced' AND event_id<>$1 AND (payload->>'loser_event_id'=$2 OR payload->>'operation_id'=$3) LIMIT 1",
      [e.event_id, p.loser_event_id, p.operation_id],
    );
    check(
      !duplicate,
      'reconciliations',
      p.operation_id,
      'duplicate_consumption',
    );
    const [collision] = await m.query(
      'SELECT id FROM sale_adjustments WHERE id=$1',
      [p.operation_id],
    );
    check(!collision, 'reconciliations', p.operation_id, 'operation_collision');
    const totals = new Map<string, bigint>();
    for (const r of p.recovery_effects) {
      const key = r.ledger + '/' + r.target_id,
        value = (totals.get(key) ?? 0n) + BigInt(r.delta);
      totals.set(key, value);
      const preserved = p.preserved_effects
        .filter((x) => x.ledger === r.ledger && x.target_id === r.target_id)
        .reduce((n, x) => n + BigInt(x.delta), 0n);
      check(
        r.occurred_at_ms >= frozen.occurred_at_ms &&
          preserved !== 0n &&
          value < 0n !== preserved < 0n &&
          (value < 0n ? -value : value) <=
            (preserved < 0n ? -preserved : preserved),
        'reconciliations',
        r.effect_id,
        'unjustified_recovery',
      );
    }
    const effects = [...p.preserved_effects, ...p.recovery_effects];
    const actual = await m.query(
      'SELECT * FROM sale_reconciliation_effects WHERE event_id=$1',
      [e.event_id],
    );
    check(
      actual.length === effects.length,
      'reconciliations',
      p.operation_id,
      'exact_effect_set',
    );
    for (const x of effects) {
      compare(
        actual.find((r) => r.effect_id === x.effect_id),
        {
          event_id: e.event_id,
          ledger: x.ledger,
          target_id: x.target_id,
          delta: String(x.delta),
          cash_session_id: x.cash_session_id,
          is_recovery: p.recovery_effects.some(
            (r) => r.effect_id === x.effect_id,
          ),
          payload: x,
        },
        'sale_reconciliation_effects',
        x.effect_id,
      );
      const [physical] = await m.query(
        'SELECT movement_id FROM inventory_movements WHERE movement_id=$1 UNION ALL SELECT id FROM cash_movements WHERE id=$1 UNION ALL SELECT id FROM sale_adjustments WHERE id=$1',
        [x.effect_id],
      );
      check(
        !physical,
        'sale_reconciliation_effects',
        x.effect_id,
        'double_physical_effect',
      );
      if (x.ledger === 'stock') {
        const [item] = await m.query(
          'SELECT inventory_item_id FROM inventory_items WHERE inventory_item_id=$1',
          [x.target_id],
        );
        check(
          item,
          'sale_reconciliation_effects',
          x.effect_id,
          'stock_target_missing',
        );
      }
      if (x.ledger === 'credit') {
        const [customer] = await m.query(
          'SELECT cliente_id FROM clientes WHERE cliente_id=$1',
          [x.target_id],
        );
        check(
          customer,
          'sale_reconciliation_effects',
          x.effect_id,
          'credit_target_missing',
        );
      }
      if (x.cash_session_id) {
        const [session] = await m.query(
            'SELECT * FROM cash_sessions WHERE id=$1',
            [x.cash_session_id],
          ),
          opening = await event(m, x.opening_event_id!, e);
        check(
          session &&
            session.created_event_id === opening.event_id &&
            session.device_id === e.device_id,
          'sale_reconciliation_effects',
          x.effect_id,
          'cash_identity',
        );
        if (p.recovery_effects.includes(x))
          check(
            BigInt(x.occurred_at_ms) >= BigInt(session.opened_at_ms) &&
              (session.status === 'open' ||
                BigInt(session.last_server_sequence) >
                  BigInt(e.server_sequence)),
            'sale_reconciliation_effects',
            x.effect_id,
            'recovery_cash_closed',
          );
      }
    }
    const incident = await sidecar('sale_delivery_incidents', p.incident_id);
    // The remote server does not distribute its administrative incident table.
    // A local sidecar, when present, must be the resolved original, never invented.
    if (incident) {
      if (incident.blocked_by_event_id) {
        const blocked = (
          await m.query('SELECT sync_status FROM events WHERE event_id=$1', [
            incident.blocked_by_event_id,
          ])
        )[0];
        await event(m, incident.blocked_by_event_id, e, blocked?.sync_status);
      }
      compare(
        incident,
        {
          active: true,
          version: 1,
          sale_id: p.sale_id,
          loser_event_id: p.loser_event_id,
          winner_event_id: p.winner_event_id,
          resolution_event_id: e.event_id,
          preserved_payload_json: loser.payload,
          created_event_id: p.loser_event_id,
          last_event_id: e.event_id,
          last_server_sequence: String(e.server_sequence),
        },
        'sale_delivery_incidents',
        p.incident_id,
      );
    }
  }
  let cursor = '';
  for (;;) {
    const rows = await m.query(
      "SELECT row_key,row_data FROM recovery_rows WHERE recovery_id=$1 AND entity='sale_delivery_incidents' AND row_key>$2 ORDER BY row_key LIMIT 200",
      [recoveryId, cursor],
    );
    if (!rows.length) break;
    for (const r of rows) {
      cursor = r.row_key;
      const resolution = await event(m, r.row_data.resolution_event_id);
      check(
        resolution.event_type === OperacionVentaConciliadaPayload.eventType &&
          resolution.payload.incident_id === r.row_data.id,
        'sale_delivery_incidents',
        r.row_data.id,
        'resolution_missing',
      );
    }
  }
  cursor = '';
  for (;;) {
    const rows = await m.query(
      "SELECT row_key,row_data FROM recovery_rows WHERE recovery_id=$1 AND entity='sale_adjustment_evidence' AND row_key>$2 ORDER BY row_key LIMIT 200",
      [recoveryId, cursor],
    );
    if (!rows.length) break;
    for (const r of rows) {
      cursor = r.row_key;
      const d = r.row_data,
        loser = await event(
          m,
          d.event_id,
          undefined,
          (
            await m.query('SELECT sync_status FROM events WHERE event_id=$1', [
              d.event_id,
            ])
          )[0]?.sync_status,
        ),
        a = parseSaleAdjustmentPayload(loser.payload);
      check(
        ['rejected', 'conflict'].includes(loser.sync_status) &&
          d.commercial_active === false &&
          canonical(d.payload_json) === canonical(loser.payload),
        'sale_adjustment_evidence',
        d.id,
        'loser_missing',
      );
      compare(
        d,
        {
          id: a.operation_id,
          active: true,
          version: 1,
          created_event_id: a.event_id,
          last_event_id: a.event_id,
          sale_id: a.sale_id,
          confirmation_event_id: a.confirmation_event_id,
          base_event_id:
            a.previous_adjustment_event_id ?? a.confirmation_event_id,
          event_id: a.event_id,
          kind: a.kind,
          revision: a.expected_revision + 1,
          business_date: a.business_date,
          occurred_at_ms: String(a.occurred_at_ms),
          utc_offset_minutes: a.utc_offset_minutes,
          reason: a.reason,
          user_id: loser.user_id,
          device_id: loser.device_id,
          amount_minor: String(a.total_minor),
          method: a.settlement.method,
          sale_payment_id: a.settlement.payment_id,
          cliente_id: a.settlement.cliente_id,
          currency: a.currency,
          settlement_reference: a.settlement.reference,
          cash_enabled: a.settlement.cash_enabled,
          settlement_action: a.settlement.action,
        },
        'sale_adjustment_evidence',
        d.id,
      );
      check(
        d.last_server_sequence === null ||
          String(d.last_server_sequence) === String(loser.server_sequence),
        'sale_adjustment_evidence',
        d.id,
        'original_sequence',
      );
      const [resolution] = await m.query(
        "SELECT event_id FROM events WHERE event_type='operacion_venta_conciliada' AND sync_status='synced' AND payload->>'loser_event_id'=$1",
        [d.event_id],
      );
      check(
        resolution,
        'sale_adjustment_evidence',
        d.id,
        'unresolved_physical_branch',
      );
    }
  }
  const [orphan] = await m.query(
    "SELECT r.effect_id FROM sale_reconciliation_effects r LEFT JOIN events e ON e.event_id=r.event_id WHERE e.event_type IS DISTINCT FROM 'operacion_venta_conciliada' OR e.sync_status IS DISTINCT FROM 'synced' LIMIT 1",
  );
  check(
    !orphan,
    'sale_reconciliation_effects',
    orphan?.effect_id,
    'resolution_missing',
  );
  const projections = await m.query(
    "SELECT row_data FROM recovery_rows WHERE recovery_id=$1 AND entity='projection_provenance'",
    [recoveryId],
  );
  for (const { row_data: r } of projections) {
    check(
      r.source_row &&
        Object.keys(r.source_row).sort().join(',') ===
          [
            'inventory_item_id',
            'quantity_on_hand_atomic',
            'quantity_available_atomic',
            'version',
            'last_event_id',
            'last_server_sequence',
          ]
            .sort()
            .join(','),
      'projection_provenance',
      r.row_id,
      'source_columns',
    );
    check(
      r.entity === 'inventory_balances' &&
        r.rule === 'delivered_reconciliation_once',
      'projection_provenance',
      r.row_id,
      'unknown_rule',
    );
    const [balance] = await m.query(
        'SELECT * FROM inventory_balances WHERE inventory_item_id=$1',
        [r.row_id],
      ),
      resolution = await event(m, r.canonical_event_id),
      p = OperacionVentaConciliadaPayload.fromJson(resolution.payload);
    check(
      balance &&
        p.data.loser_event_id === r.source_row.last_event_id &&
        balance.last_event_id === resolution.event_id &&
        String(balance.last_server_sequence) ===
          String(resolution.server_sequence),
      'projection_provenance',
      r.row_id,
      'canonical_identity',
    );
    compare(
      balance,
      {
        inventory_item_id: r.source_row.inventory_item_id,
        quantity_on_hand_atomic: r.source_row.quantity_on_hand_atomic,
        quantity_available_atomic: r.source_row.quantity_available_atomic,
        version: r.source_row.version,
      },
      'projection_provenance',
      r.row_id,
    );
  }
  const [discard] = await m.query(
    "SELECT row_key FROM recovery_rows WHERE recovery_id=$1 AND entity='inventory_item_discards' LIMIT 1",
    [recoveryId],
  );
  // Discard is a standalone-only command in the current schema. V1 forbids its
  // conversion into server_sync evidence; never manufacture an official event.
  check(
    !discard,
    'inventory_item_discards',
    discard?.row_key,
    'standalone_history_not_importable',
  );
}
