import { MigrationInterface, QueryRunner } from 'typeorm';
/** Aditiva. Down rechaza retirar evidencia comercial; nunca borra operaciones. */
export class CreateSaleAdjustments1793145600000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE sale_adjustments (
   id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES events(event_id) ON DELETE RESTRICT,
   sale_id uuid NOT NULL REFERENCES sales(sale_id) ON DELETE RESTRICT,
   revision integer NOT NULL CHECK(revision>0), kind text NOT NULL CHECK(kind IN ('void','return')),
   reason text NOT NULL CHECK(reason=btrim(reason) AND length(reason) BETWEEN 1 AND 500),
   total_minor bigint NOT NULL CHECK(total_minor BETWEEN 0 AND 9007199254740991),
   occurred_at_ms bigint NOT NULL CHECK(occurred_at_ms>0), utc_offset_minutes integer NOT NULL CHECK(abs(utc_offset_minutes)<=840),
   business_date text NOT NULL, currency text NOT NULL CHECK(currency='MXN'), method text NOT NULL CHECK(method IN ('cash','transfer','credit')),
   settlement_action text NOT NULL CHECK(settlement_action IN ('refund_completed','unreceived_correction','credit_reduction','no_money')), reference text,
   payment_id uuid REFERENCES sale_payments(payment_id) ON DELETE RESTRICT,
   cliente_id uuid REFERENCES clientes(cliente_id) ON DELETE RESTRICT,
   active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
   created_event_id uuid, last_event_id uuid, last_server_sequence bigint,
   created_at_server timestamptz(3) NOT NULL DEFAULT now(), updated_at_server timestamptz(3) NOT NULL DEFAULT now(),
   CONSTRAINT ck_sale_adjustment_settlement CHECK((method='credit' AND payment_id IS NULL AND cliente_id IS NOT NULL) OR (method IN ('cash','transfer') AND payment_id IS NOT NULL)),
   CONSTRAINT ux_sale_adjustment_revision UNIQUE(sale_id,revision)
  )`);
    await q.query(
      `CREATE UNIQUE INDEX ux_sale_adjustment_void ON sale_adjustments(sale_id) WHERE kind='void'`,
    );
    await q.query(
      `CREATE INDEX ix_sale_adjustment_date ON sale_adjustments(business_date)`,
    );
    await q.query(`CREATE TABLE sale_adjustment_lines (
   operation_id uuid NOT NULL REFERENCES sale_adjustments(id) ON DELETE RESTRICT,
   sale_item_id uuid NOT NULL REFERENCES sale_items(sale_item_id) ON DELETE RESTRICT,
   quantity_atomic bigint NOT NULL CHECK(quantity_atomic BETWEEN 1 AND 9007199254740991),
   amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 9007199254740991),
   recovered_cost_minor bigint CHECK(recovered_cost_minor BETWEEN 0 AND 9007199254740991),
   destination text NOT NULL CHECK(destination IN ('void','restock','not_restockable','untracked')), reason text,
   PRIMARY KEY(operation_id,sale_item_id)
  )`);
    await q.query(`CREATE TABLE sale_credit_reductions (
   operation_id uuid PRIMARY KEY REFERENCES sale_adjustments(id) ON DELETE RESTRICT,
   credit_id uuid NOT NULL REFERENCES credit_sales(id) ON DELETE RESTRICT,
   amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 1 AND 9007199254740991)
  )`);
    await q.query(
      `CREATE INDEX ix_sale_reductions_credit ON sale_credit_reductions(credit_id)`,
    );
    await q.query(`ALTER TABLE cash_movements ADD COLUMN sale_adjustment_id uuid UNIQUE REFERENCES sale_adjustments(id) ON DELETE RESTRICT,
   DROP CONSTRAINT ck_cash_movement_source,
   ADD CONSTRAINT ck_cash_movement_source CHECK(num_nonnulls(sale_payment_id,customer_payment_id,financial_entry_id,sale_adjustment_id)=1),
   ADD CONSTRAINT ck_cash_adjustment_direction CHECK(sale_adjustment_id IS NULL OR direction='out')`);
    await q.query(`ALTER TABLE inventory_movements ADD COLUMN sale_adjustment_id uuid REFERENCES sale_adjustments(id) ON DELETE RESTRICT,
   DROP CONSTRAINT ck_inventory_movements_reversal_reference,
   ADD CONSTRAINT ck_inventory_movements_reversal_reference CHECK((movement_type IN ('reversal','sale_void_restock','sale_return_restock'))=(reversal_of_movement_id IS NOT NULL)),
   ADD CONSTRAINT ck_inventory_adjustment_origin CHECK((movement_type IN ('sale_void_restock','sale_return_restock'))=(sale_adjustment_id IS NOT NULL) AND (sale_adjustment_id IS NULL OR (sale_item_id IS NOT NULL AND quantity_delta_atomic>0 AND total_cost_minor IS NULL)))`);
    await q.query(
      `CREATE INDEX ix_inventory_adjustment ON inventory_movements(sale_adjustment_id)`,
    );
    await q.query(
      `CREATE UNIQUE INDEX ux_adjustment_consumption ON inventory_movements(sale_adjustment_id,reversal_of_movement_id) WHERE sale_adjustment_id IS NOT NULL`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    if ((await q.query('SELECT 1 FROM sale_adjustments LIMIT 1')).length)
      throw new Error('No se puede retirar evidencia de ajustes existentes.');
    await q.query(`ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS ck_inventory_adjustment_origin, DROP CONSTRAINT ck_inventory_movements_reversal_reference, DROP COLUMN sale_adjustment_id,
   ADD CONSTRAINT ck_inventory_movements_reversal_reference CHECK((movement_type='reversal')=(reversal_of_movement_id IS NOT NULL))`);
    await q.query(`ALTER TABLE cash_movements DROP CONSTRAINT IF EXISTS ck_cash_adjustment_direction, DROP CONSTRAINT ck_cash_movement_source, DROP COLUMN sale_adjustment_id,
   ADD CONSTRAINT ck_cash_movement_source CHECK(num_nonnulls(sale_payment_id,customer_payment_id,financial_entry_id)=1)`);
    await q.query(
      'DROP TABLE sale_credit_reductions, sale_adjustment_lines, sale_adjustments',
    );
  }
}
