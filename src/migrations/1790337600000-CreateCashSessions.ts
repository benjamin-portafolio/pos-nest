import { MigrationInterface, QueryRunner } from 'typeorm';
/** Aditiva; nunca asigna registros históricos a sesiones. */
export class CreateCashSessions1790337600000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    const common = `active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
      created_event_id uuid, last_event_id uuid, last_server_sequence bigint,
      created_at_server timestamptz(3) NOT NULL DEFAULT now(), updated_at_server timestamptz(3) NOT NULL DEFAULT now()`;
    await r.query(`CREATE TABLE cash_sessions (id uuid PRIMARY KEY, ${common},
      device_id text NOT NULL, opened_by_user_id text NOT NULL, closed_by_user_id text,
      status text NOT NULL CHECK(status IN ('open','closed')), opened_at_ms bigint NOT NULL, closed_at_ms bigint,
      opening_minor bigint NOT NULL CHECK(opening_minor BETWEEN 0 AND 9007199254740991),
      counted_minor bigint CHECK(counted_minor BETWEEN 0 AND 9007199254740991),
      income_minor numeric, expense_minor numeric, expected_minor numeric, difference_minor numeric,
      close_snapshot jsonb, previous_close_event_id uuid, notes text CHECK(notes IS NULL OR char_length(notes)<=500),
      CHECK((status='open' AND closed_at_ms IS NULL AND closed_by_user_id IS NULL AND counted_minor IS NULL AND close_snapshot IS NULL AND income_minor IS NULL AND expense_minor IS NULL AND expected_minor IS NULL AND difference_minor IS NULL) OR
      (status='closed' AND closed_at_ms IS NOT NULL AND closed_by_user_id IS NOT NULL AND counted_minor IS NOT NULL AND close_snapshot IS NOT NULL AND income_minor IS NOT NULL AND expense_minor IS NOT NULL AND expected_minor IS NOT NULL AND difference_minor IS NOT NULL)))`);
    await r.query("CREATE UNIQUE INDEX uq_cash_session_open_device ON cash_sessions(device_id) WHERE status='open'");
    await r.query(`CREATE TABLE cash_movements (id uuid PRIMARY KEY, ${common},
      session_id uuid NOT NULL REFERENCES cash_sessions(id) ON DELETE RESTRICT,
      direction text NOT NULL CHECK(direction IN ('in','out')),
      amount_minor bigint NOT NULL CHECK(amount_minor > 0 AND amount_minor <= 9007199254740991),
      sale_payment_id uuid UNIQUE REFERENCES sale_payments(payment_id) ON DELETE RESTRICT,
      customer_payment_id uuid UNIQUE REFERENCES customer_payments(id) ON DELETE RESTRICT,
      financial_entry_id uuid UNIQUE REFERENCES financial_entries(id) ON DELETE RESTRICT,
      CHECK(num_nonnulls(sale_payment_id,customer_payment_id,financial_entry_id)=1))`);
    await r.query('CREATE INDEX ix_cash_movements_session ON cash_movements(session_id)');
  }
  async down(r: QueryRunner): Promise<void> {
    const rows = await r.query('SELECT EXISTS(SELECT 1 FROM cash_sessions) AS populated') as {populated:boolean}[];
    if(rows[0].populated) throw new Error('No se puede retirar caja con historial.');
    await r.query('DROP TABLE cash_movements');
    await r.query('DROP TABLE cash_sessions');
  }
}
