import { EntityManager } from 'typeorm';
import { RecursoInventarioCreadoPayload } from '../sync/payloads/recurso-inventario-creado.payload';
import { RecursoInventarioActualizadoPayload } from '../sync/payloads/recurso-inventario-actualizado.payload';
import { RecursoInventarioEliminadoPayload } from '../sync/payloads/recurso-inventario-eliminado.payload';
import { MovimientoInventarioRegistradoPayload } from '../sync/payloads/movimiento-inventario-registrado.payload';
import { recoveryError } from './recovery-errors';

/** Exact physical ledger validation. No replay, synthetic opening or balance repair. */
export async function validateRecoveryInventory(m: EntityManager) {
  const assert = (ok: boolean, id: string, rule: string) => {
    if (!ok) recoveryError(422, 'inventory_invariant', { id, rule });
  };
  let after = '';
  for (;;) {
    const rows = await m.query(
      'SELECT * FROM inventory_items WHERE inventory_item_id::text>$1 ORDER BY inventory_item_id LIMIT 500',
      [after],
    );
    if (!rows.length) break;
    for (const item of rows) {
      after = item.inventory_item_id;
      const [creation] = await m.query(
        "SELECT * FROM events WHERE aggregate_type='inventory_item' AND aggregate_id=$1 AND sync_status='synced' ORDER BY server_sequence LIMIT 1",
        [after],
      );
      assert(
        creation?.event_type === RecursoInventarioCreadoPayload.eventType &&
          creation.event_id === item.created_event_id,
        after,
        'creator',
      );
      const created = RecursoInventarioCreadoPayload.fromJson(creation.payload);
      assert(
        created.inventoryItemId === after &&
          created.defaultUnitId === item.default_unit_id &&
          created.originVariantId === item.origin_variant_id,
        after,
        'identity',
      );
      // Renames and stock operations share the item version. A sale changes the
      // balance, but never advances the item configuration version.
      let name = created.name;
      let active = true;
      let prior = creation;
      assert(
        creation.base_version === 1 && creation.base_server_sequence === null,
        after,
        'initial_version',
      );
      let version = 1;
      for await (const event of inventoryHistory(m, after)) {
        if (event.event_id === creation.event_id) continue;
        assert(
          active &&
            event.payload.base_event_id === prior.event_id &&
            event.base_version ===
              prior.base_version + (prior === creation ? 0 : 1) &&
            (event.base_server_sequence === null ||
              String(event.base_server_sequence) ===
                String(prior.server_sequence)),
          after,
          'base_chain',
        );
        switch (event.event_type) {
          case RecursoInventarioActualizadoPayload.eventType: {
            const p = RecursoInventarioActualizadoPayload.fromJson(
              event.payload,
            );
            assert(p.previousName === name, after, 'rename_before');
            name = p.nextName;
            break;
          }
          case RecursoInventarioEliminadoPayload.eventType:
            RecursoInventarioEliminadoPayload.fromJson(event.payload);
            active = false;
            break;
          case MovimientoInventarioRegistradoPayload.eventType: {
            const p = MovimientoInventarioRegistradoPayload.fromJson(
              event.payload,
            );
            assert(
              !['initial_balance', 'sale_consumption'].includes(
                p.movement.movementType,
              ),
              after,
              'movement_kind',
            );
            break;
          }
          default:
            assert(false, event.event_id, 'unsupported_item_event');
        }
        prior = event;
        version++;
      }
      assert(
        item.name === name &&
          item.active === active &&
          item.version === version &&
          item.last_event_id === prior.event_id &&
          String(item.last_server_sequence) === String(prior.server_sequence),
        after,
        'projection',
      );
      const [balance] = await m.query(
        'SELECT * FROM inventory_balances WHERE inventory_item_id=$1',
        [after],
      );
      assert(!!balance, after, 'missing_balance');
      const [ledger] = await m.query(
        "SELECT ((SELECT coalesce(sum(quantity_delta_atomic),0) FROM inventory_movements WHERE inventory_item_id=$1)+(SELECT coalesce(sum(delta),0) FROM sale_reconciliation_effects WHERE ledger='stock' AND target_id=$1))::text AS quantity",
        [after],
      );
      assert(
        balance.quantity_on_hand_atomic === ledger.quantity &&
          balance.quantity_available_atomic === ledger.quantity,
        after,
        'ledger_sum',
      );

      const [last] = await m.query(
        "SELECT e.event_id,e.server_sequence FROM events e WHERE e.event_id=$1 AND e.sync_status='synced'",
        [balance.last_event_id],
      );
      assert(
        !!last &&
          String(last.server_sequence) === String(balance.last_server_sequence),
        after,
        'balance_provenance',
      );
      const [effects] = await m.query(
        'SELECT count(DISTINCT event_id)::int AS n FROM inventory_movements WHERE inventory_item_id=$1 AND event_id<>$2',
        [after, creation.event_id],
      );
      const [lost] = await m.query(
        `SELECT count(*)::int AS n FROM recovery_rows WHERE recovery_id=(SELECT active_recovery_id FROM server_state WHERE singleton) AND entity='sale_adjustment_evidence' AND EXISTS(SELECT 1 FROM jsonb_array_elements(row_data->'payload_json'->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'stock') s WHERE s->>'inventory_item_id'=$1)`,
        [after],
      );
      assert(
        balance.version === effects.n + lost.n + 1,
        after,
        'balance_version',
      );
      const [reconciliations] = await m.query(
        "SELECT count(*)::int AS n FROM sale_reconciliation_effects WHERE ledger='stock' AND target_id=$1",
        [after],
      );
      const [latest] = await m.query(
        'SELECT event_id FROM inventory_movements WHERE inventory_item_id=$1 ORDER BY server_sequence DESC LIMIT 1',
        [after],
      );
      const [touch] = await m.query(
        "SELECT 1 FROM inventory_movements WHERE inventory_item_id=$1 AND event_id=$2 UNION ALL SELECT 1 FROM sale_reconciliation_effects WHERE ledger='stock' AND target_id=$1 AND event_id=$2 LIMIT 1",
        [after, balance.last_event_id],
      );
      assert(
        balance.last_event_id === creation.event_id || !!touch,
        after,
        'balance_unrelated_event',
      );
      assert(
        reconciliations.n > 0 ||
          balance.last_event_id === (latest?.event_id ?? creation.event_id),
        after,
        'balance_last_event',
      );
      // Every accredited stock fact must have exactly its declared movement;
      // conversely each physical row below must be explained by one such fact.
      for await (const event of inventoryHistory(m, after)) {
        const movement =
          event.event_id === creation.event_id
            ? created.initialMovement
            : event.event_type ===
                MovimientoInventarioRegistradoPayload.eventType
              ? MovimientoInventarioRegistradoPayload.fromJson(event.payload)
                  .movement
              : null;
        if (!movement) continue;
        const [row] = await m.query(
          'SELECT * FROM inventory_movements WHERE movement_id=$1',
          [movement.movementId],
        );
        assert(
          !!row &&
            row.event_id === event.event_id &&
            row.inventory_item_id === after &&
            row.sale_item_id === null &&
            row.sale_adjustment_id === null &&
            row.movement_type === movement.movementType &&
            row.quantity_delta_atomic ===
              String(movement.quantityDeltaAtomic) &&
            row.total_cost_minor === null &&
            row.reason === movement.reason &&
            row.reversal_of_movement_id === movement.reversalOfMovementId &&
            String(row.server_sequence) === String(event.server_sequence) &&
            new Date(row.created_at_local).getTime() ===
              new Date(event.created_at_local).getTime(),
          movement.movementId,
          'movement_evidence',
        );
        if (movement.reversalOfMovementId) {
          const [original] = await m.query(
            'SELECT * FROM inventory_movements WHERE movement_id=$1',
            [movement.reversalOfMovementId],
          );
          assert(
            !!original &&
              original.inventory_item_id === after &&
              BigInt(original.server_sequence) <
                BigInt(event.server_sequence) &&
              BigInt(original.quantity_delta_atomic) ===
                -BigInt(movement.quantityDeltaAtomic) &&
              original.movement_type !== 'reversal',
            movement.movementId,
            'reversal',
          );
          const [count] = await m.query(
            'SELECT count(*)::int AS n FROM inventory_movements WHERE reversal_of_movement_id=$1',
            [movement.reversalOfMovementId],
          );
          assert(count.n === 1, movement.movementId, 'duplicate_reversal');
        }
      }
    }
  }
  const [orphanMutation] = await m.query(
    "SELECT e.event_id FROM events e LEFT JOIN inventory_items i ON i.inventory_item_id=e.aggregate_id WHERE e.sync_status='synced' AND e.aggregate_type='inventory_item' AND i.inventory_item_id IS NULL LIMIT 1",
  );
  if (orphanMutation)
    recoveryError(422, 'missing_projection', {
      entity: 'inventory_items',
      ...orphanMutation,
    });
  const [orphan] = await m.query(
    `SELECT e.event_id,e.aggregate_id FROM events e LEFT JOIN inventory_items i ON i.inventory_item_id=e.aggregate_id WHERE e.sync_status='synced' AND e.event_type='recurso_inventario_creado' AND (i.inventory_item_id IS NULL OR i.created_event_id IS DISTINCT FROM e.event_id) LIMIT 1`,
  );
  if (orphan)
    recoveryError(422, 'missing_projection', {
      entity: 'inventory_items',
      ...orphan,
    });
  const [unexplained] = await m.query(`
    SELECT v.movement_id FROM inventory_movements v LEFT JOIN events e ON e.event_id=v.event_id
    WHERE e.sync_status IS DISTINCT FROM 'synced' OR NOT (
      (e.aggregate_type='inventory_item' AND e.aggregate_id=v.inventory_item_id AND v.movement_id::text=coalesce(e.payload->'initial_movement'->>'movement_id',e.payload->'movement'->>'movement_id'))
      OR (e.event_type='venta_confirmada' AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'consumptions') c WHERE c->>'movement_id'=v.movement_id::text))
      OR (e.event_type IN ('venta_anulada','devolucion_venta_registrada') AND EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload->'lines') l CROSS JOIN LATERAL jsonb_array_elements(l->'stock') c WHERE c->>'movement_id'=v.movement_id::text))
    ) LIMIT 1`);
  if (unexplained)
    recoveryError(422, 'unexplained_inventory_movement', unexplained);
}

async function* inventoryHistory(
  m: EntityManager,
  itemId: string,
): AsyncGenerator<any> {
  let cursor = '0';
  for (;;) {
    const page = await m.query(
      "SELECT * FROM events WHERE aggregate_type='inventory_item' AND aggregate_id=$1 AND sync_status='synced' AND server_sequence>$2 ORDER BY server_sequence LIMIT 500",
      [itemId, cursor],
    );
    if (!page.length) return;
    for (const event of page) {
      cursor = event.server_sequence;
      yield event;
    }
  }
}
