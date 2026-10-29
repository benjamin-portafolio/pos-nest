import { MigrationInterface, QueryRunner } from 'typeorm';
export class CreateSaleReconciliationEffects1793232000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE sale_reconciliation_effects (
      effect_id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES events(event_id) ON DELETE RESTRICT,
      ledger text NOT NULL CHECK(ledger IN ('stock','cash','credit','transfer')),
      target_id uuid NOT NULL, delta bigint NOT NULL CHECK(delta<>0 AND abs(delta)<=9007199254740991),
      cash_session_id uuid REFERENCES cash_sessions(id) ON DELETE RESTRICT, is_recovery boolean NOT NULL, payload jsonb NOT NULL
    )`);
    await q.query(
      `CREATE TABLE sale_reconciliation_credit_allocations (source_id uuid NOT NULL,target_id uuid NOT NULL,cliente_id uuid NOT NULL REFERENCES clientes(cliente_id) ON DELETE RESTRICT,amount_minor bigint NOT NULL CHECK(amount_minor>0),PRIMARY KEY(source_id,target_id))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX ux_reconciliation_operation ON events ((payload->>'operation_id')) WHERE event_type='operacion_venta_conciliada' AND sync_status='synced'`,
    );
    await q.query(
      `CREATE UNIQUE INDEX ux_reconciliation_loser ON events ((payload->>'loser_event_id')) WHERE event_type='operacion_venta_conciliada' AND sync_status='synced'`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    if (
      (await q.query('SELECT 1 FROM sale_reconciliation_effects LIMIT 1'))
        .length ||
      (
        await q.query(
          "SELECT 1 FROM events WHERE event_type='operacion_venta_conciliada' AND sync_status='synced' LIMIT 1",
        )
      ).length
    )
      throw new Error('No se puede retirar evidencia de conciliación.');
    await q.query('DROP INDEX ux_reconciliation_loser');
    await q.query('DROP INDEX ux_reconciliation_operation');
    await q.query('DROP TABLE sale_reconciliation_credit_allocations');
    await q.query('DROP TABLE sale_reconciliation_effects');
  }
}
