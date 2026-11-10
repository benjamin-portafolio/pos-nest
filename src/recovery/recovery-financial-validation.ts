import { EntityManager } from 'typeorm';
import { CategoriaFinancieraCreadaPayload } from '../sync/payloads/categoria-financiera-creada.payload';
import { MovimientoFinancieroRegistradoPayload } from '../sync/payloads/movimiento-financiero-registrado.payload';
import { AbonoClienteRegistradoPayload } from '../sync/payloads/abono-cliente-registrado.payload';
import { SaldoCuentaInicialDeclaradoPayload } from '../sync/payloads/saldo-cuenta-inicial-declarado.payload';
import { canonical } from './recovery-contract';
import { recoveryError } from './recovery-errors';

export const RECOVERY_FINANCIAL_PARSERS = [
  CategoriaFinancieraCreadaPayload,
  MovimientoFinancieroRegistradoPayload,
  AbonoClienteRegistradoPayload,
  SaldoCuentaInicialDeclaradoPayload,
];

/** Verifies original immutable money facts and their complete projections. */
export async function validateRecoveryFinancial(m: EntityManager) {
  const families = [
    { table: 'financial_categories', parser: CategoriaFinancieraCreadaPayload },
    {
      table: 'financial_entries',
      parser: MovimientoFinancieroRegistradoPayload,
    },
    { table: 'customer_payments', parser: AbonoClienteRegistradoPayload },
    {
      table: 'account_balance_baselines',
      parser: SaldoCuentaInicialDeclaradoPayload,
    },
  ];
  for (const { table, parser } of families) {
    const [invalid] = await m.query(
      `SELECT p.id FROM "${table}" p LEFT JOIN events e ON e.event_id=p.created_event_id WHERE e.sync_status IS DISTINCT FROM 'synced' OR e.aggregate_type<>$1 OR e.event_type<>$2 OR e.aggregate_id<>p.id OR p.version<>1 OR p.active IS DISTINCT FROM true OR p.last_event_id IS DISTINCT FROM p.created_event_id OR p.last_server_sequence IS DISTINCT FROM e.server_sequence LIMIT 1`,
      [parser.aggregateType, parser.eventType],
    );
    if (invalid)
      recoveryError(422, 'financial_provenance', { entity: table, ...invalid });
    const [missing] = await m.query(
      `SELECT e.event_id FROM events e LEFT JOIN "${table}" p ON p.id=e.aggregate_id AND p.created_event_id=e.event_id WHERE e.sync_status='synced' AND e.event_type=$1 AND p.id IS NULL LIMIT 1`,
      [parser.eventType],
    );
    if (missing)
      recoveryError(422, 'missing_projection', { entity: table, ...missing });
    let after = '';
    for (;;) {
      const rows = await m.query(
        `SELECT p.*,e.payload,e.device_id AS source_device,e.user_id AS source_user,e.base_version,e.base_server_sequence FROM "${table}" p JOIN events e ON e.event_id=p.created_event_id WHERE p.id::text>$1 ORDER BY p.id LIMIT 500`,
        [after],
      );
      if (!rows.length) break;
      for (const row of rows) {
        after = row.id;
        let expected: Record<string, unknown>;
        if (row.base_version !== 1 || row.base_server_sequence !== null)
          recoveryError(422, 'invalid_event_version', {
            event_id: row.created_event_id,
          });
        switch (table) {
          case 'financial_categories': {
            const p = CategoriaFinancieraCreadaPayload.fromJson(row.payload);
            expected = {
              name: p.name,
              direction: p.direction,
              nature: p.nature,
            };
            break;
          }
          case 'financial_entries': {
            const p = MovimientoFinancieroRegistradoPayload.fromJson(
              row.payload,
            );
            const [category] = await m.query(
              'SELECT * FROM financial_categories WHERE id=$1 AND created_event_id=$2',
              [p.categoryId, p.categoryEventId],
            );
            if (
              !category ||
              category.name !== p.categoryNameSnapshot ||
              category.direction !== p.direction ||
              category.nature !== p.nature ||
              BigInt(category.last_server_sequence) >=
                BigInt(row.last_server_sequence)
            )
              recoveryError(422, 'dependency_missing', {
                entity: table,
                id: row.id,
                dependency: p.categoryEventId,
              });
            expected = {
              category_id: p.categoryId,
              category_name_snapshot: p.categoryNameSnapshot,
              direction: p.direction,
              nature: p.nature,
              amount_minor: String(p.amountMinor),
              currency: 'MXN',
              method: p.method,
              occurred_at_ms: String(p.occurredAtMs),
              notes: p.notes,
              reference: p.reference,
            };
            break;
          }
          case 'customer_payments': {
            const p = AbonoClienteRegistradoPayload.fromJson(row.payload);
            const [customer] = await m.query(
              'SELECT c.cliente_id,e.server_sequence FROM clientes c JOIN events e ON e.event_id=c.created_event_id WHERE c.cliente_id=$1 AND c.created_event_id=$2',
              [p.clienteId, p.clienteEventId],
            );
            if (
              !customer ||
              BigInt(customer.server_sequence) >=
                BigInt(row.last_server_sequence)
            )
              recoveryError(422, 'dependency_missing', {
                entity: table,
                id: row.id,
                dependency: p.clienteEventId,
              });
            expected = {
              cliente_id: p.clienteId,
              amount_minor: String(p.amountMinor),
              method: p.method,
              reference: p.reference,
              occurred_at_ms: String(p.occurredAtMs),
            };
            break;
          }
          default: {
            const p = SaldoCuentaInicialDeclaradoPayload.fromJson(row.payload);
            expected = {
              device_id: row.source_device,
              declared_by_user_id: row.source_user,
              amount_minor: String(p.amountMinor),
              as_of_ms: String(p.asOfMs),
            };
          }
        }
        for (const [key, value] of Object.entries(expected))
          if (canonical(row[key]) !== canonical(value))
            recoveryError(422, 'financial_invariant', {
              entity: table,
              id: row.id,
              field: key,
            });
      }
    }
  }
}
