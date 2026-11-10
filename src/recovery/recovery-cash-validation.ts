import { EntityManager } from 'typeorm';
import { CajaAbiertaPayload } from '../sync/payloads/caja-abierta.payload';
import { CajaCerradaPayload } from '../sync/payloads/caja-cerrada.payload';
import { CashOperationPayload } from '../sync/payloads/cash-operation.payload';
import { CashMovementEvidence } from '../sync/payloads/cash-movement-evidence';
import { OperacionVentaConciliadaPayload } from '../sync/payloads/operacion-venta-conciliada.payload';
import {
  recoveryAssert as check,
  recoveryCompare as compare,
  recoveryEvent as event,
  recoveryHistory as history,
  recoveryMetadata as metadata,
} from './recovery-business-validation';

export async function validateRecoveryCash(m: EntityManager) {
  const [missingOpening] = await m.query(
    "SELECT e.event_id FROM events e LEFT JOIN cash_sessions s ON s.id=e.aggregate_id WHERE e.sync_status='synced' AND e.aggregate_type='cash_session' AND s.id IS NULL LIMIT 1",
  );
  check(
    !missingOpening,
    'cash_sessions',
    missingOpening?.event_id,
    'opening_missing',
  );
  for await (const open of history(m, "event_type='caja_abierta'", [])) {
    const id = open.aggregate_id,
      p = CajaAbiertaPayload.fromJson(open.payload);
    check(
      open.base_version === 1 && open.base_server_sequence === null,
      'cash_sessions',
      id,
      'opening_envelope',
    );
    if (p.previousCloseEventId) {
      const prior = await event(m, p.previousCloseEventId, open);
      check(
        prior.event_type === CajaCerradaPayload.eventType &&
          prior.device_id === open.device_id,
        'cash_sessions',
        id,
        'previous_close',
      );
    }
    const [session] = await m.query('SELECT * FROM cash_sessions WHERE id=$1', [
      id,
    ]);
    check(session, 'cash_sessions', id, 'missing_projection');
    const closes = await m.query(
      "SELECT * FROM events WHERE aggregate_id=$1 AND event_type='caja_cerrada' AND sync_status='synced' ORDER BY server_sequence",
      [id],
    );
    check(closes.length <= 1, 'cash_sessions', id, 'duplicate_close');
    compare(
      session,
      {
        device_id: open.device_id,
        opened_by_user_id: open.user_id,
        opened_at_ms: String(p.openedAtMs),
        opening_minor: String(p.openingMinor),
        previous_close_event_id: p.previousCloseEventId,
        active: true,
        created_event_id: open.event_id,
      },
      'cash_sessions',
      id,
    );
    const [overlap] = await m.query(
      `SELECT id FROM cash_sessions WHERE device_id=$1 AND id<>$2 AND opened_at_ms<$3::bigint AND (closed_at_ms IS NULL OR closed_at_ms>$4::bigint) LIMIT 1`,
      [
        session.device_id,
        id,
        session.closed_at_ms ?? '9007199254740991',
        session.opened_at_ms,
      ],
    );
    check(!overlap, 'cash_sessions', id, 'overlapping_sessions');
    if (!closes.length)
      compare(
        session,
        {
          ...metadata(open),
          status: 'open',
          closed_by_user_id: null,
          closed_at_ms: null,
          counted_minor: null,
          income_minor: null,
          expense_minor: null,
          expected_minor: null,
          difference_minor: null,
          close_snapshot: null,
          notes: null,
        },
        'cash_sessions',
        id,
      );
    else {
      const close = closes[0],
        c = CajaCerradaPayload.fromJson(close.payload);
      check(
        c.openingEventId === open.event_id &&
          close.device_id === open.device_id &&
          close.base_version === 1 &&
          close.base_server_sequence === null &&
          BigInt(close.server_sequence) > BigInt(open.server_sequence) &&
          c.closedAtMs >= p.openedAtMs,
        'cash_sessions',
        id,
        'close_identity',
      );
      const evidence: CashMovementEvidence[] = [];
      const rows = await m.query(
        'SELECT * FROM cash_movements WHERE session_id=$1',
        [id],
      );
      for (const r of rows) {
        const e = await event(m, r.created_event_id, close);
        evidence.push(
          CashMovementEvidence.fromJson({
            movement_id: r.id,
            event_id: e.event_id,
            direction: r.direction,
            amount_minor: Number(r.amount_minor),
            source_type: r.sale_payment_id
              ? 'sale_payment'
              : r.customer_payment_id
                ? 'customer_payment'
                : r.sale_adjustment_id
                  ? 'sale_adjustment'
                  : 'financial_entry',
            source_id:
              r.sale_payment_id ??
              r.customer_payment_id ??
              r.sale_adjustment_id ??
              r.financial_entry_id,
          }),
        );
      }
      for (const r of await m.query(
        "SELECT * FROM sale_reconciliation_effects WHERE ledger='cash' AND cash_session_id=$1",
        [id],
      )) {
        const e = await event(m, r.event_id);
        check(
          BigInt(e.server_sequence) < BigInt(close.server_sequence),
          'cash_sessions',
          id,
          'effect_after_close',
        );
        const reconciliation = OperacionVentaConciliadaPayload.fromJson(
          e.payload,
        );
        evidence.push(
          CashMovementEvidence.fromJson({
            movement_id: r.effect_id,
            event_id: e.event_id,
            direction: BigInt(r.delta) > 0n ? 'in' : 'out',
            amount_minor: Number(
              BigInt(r.delta) > 0n ? BigInt(r.delta) : -BigInt(r.delta),
            ),
            source_type: 'sale_reconciliation',
            source_id: reconciliation.data.operation_id,
          }),
        );
      }
      try {
        c.verify(session.opening_minor, evidence);
      } catch (error) {
        check(
          false,
          'cash_sessions',
          id,
          'frozen_close: ' + (error as Error).message,
        );
      }
      compare(
        session,
        {
          ...metadata(close, 2, open.event_id),
          status: 'closed',
          closed_by_user_id: close.user_id,
          closed_at_ms: String(c.closedAtMs),
          counted_minor: String(c.countedMinor),
          income_minor: c.incomeMinor,
          expense_minor: c.expenseMinor,
          expected_minor: c.expectedMinor,
          difference_minor: c.differenceMinor,
          close_snapshot: c.toJson(),
          notes: c.notes,
        },
        'cash_sessions',
        id,
      );
    }
  }
  for await (const e of history(
    m,
    "event_type IN ('venta_confirmada','abono_cliente_registrado','movimiento_financiero_registrado','venta_anulada','devolucion_venta_registrada')",
    [],
  )) {
    const p = CashOperationPayload.fromEvent(e);
    if (!p) continue;
    const [session] = await m.query('SELECT * FROM cash_sessions WHERE id=$1', [
      p.cash.sessionId,
    ]);
    const open = await event(m, p.cash.openingEventId, e);
    check(
      session &&
        session.created_event_id === open.event_id &&
        session.device_id === e.device_id &&
        (session.status === 'open' ||
          BigInt(session.last_server_sequence) > BigInt(e.server_sequence)),
      'cash_movements',
      p.cash.movementId,
      'session_identity',
    );
    const [row] = await m.query('SELECT * FROM cash_movements WHERE id=$1', [
      p.cash.movementId,
    ]);
    compare(
      row,
      {
        ...metadata(e),
        session_id: session.id,
        direction: p.direction,
        amount_minor: String(p.amountMinor),
        sale_payment_id: p.sourceType === 'sale_payment' ? p.sourceId : null,
        customer_payment_id:
          p.sourceType === 'customer_payment' ? p.sourceId : null,
        financial_entry_id:
          p.sourceType === 'financial_entry' ? p.sourceId : null,
        sale_adjustment_id:
          p.sourceType === 'sale_adjustment' ? p.sourceId : null,
      },
      'cash_movements',
      p.cash.movementId,
    );
  }
  const [orphan] = await m.query(
    "SELECT s.id FROM cash_sessions s LEFT JOIN events e ON e.event_id=s.created_event_id WHERE e.event_type IS DISTINCT FROM 'caja_abierta' OR e.aggregate_id<>s.id OR e.sync_status IS DISTINCT FROM 'synced' LIMIT 1",
  );
  check(!orphan, 'cash_sessions', orphan?.id, 'opening_missing');
  let after = '';
  for (;;) {
    const rows = await m.query(
      'SELECT * FROM cash_movements WHERE id::text>$1 ORDER BY id LIMIT 200',
      [after],
    );
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      const e = await event(m, row.created_event_id),
        p = CashOperationPayload.fromEvent(e);
      check(
        p?.cash.movementId === row.id,
        'cash_movements',
        row.id,
        'unexplained_movement',
      );
    }
  }
}
