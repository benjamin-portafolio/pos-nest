import { MigrationInterface, QueryRunner } from 'typeorm';
/** Deudas originales, abonos y distribución FIFO. No modifica cobros previos. */
export class AddCustomerCredit1790035200000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const common = `active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
      created_event_id uuid, last_event_id uuid, last_server_sequence bigint,
      created_at_server timestamptz(3) NOT NULL DEFAULT now(), updated_at_server timestamptz(3) NOT NULL DEFAULT now()`;
    await runner.query(
      'ALTER TABLE sales ADD COLUMN cliente_id uuid REFERENCES clientes(cliente_id) ON DELETE RESTRICT',
    );
    await runner.query(`CREATE TABLE credit_sales (id uuid PRIMARY KEY, ${common},
      sale_id uuid NOT NULL UNIQUE REFERENCES sales(sale_id) ON DELETE RESTRICT,
      cliente_id uuid NOT NULL REFERENCES clientes(cliente_id) ON DELETE RESTRICT,
      amount_minor bigint NOT NULL, occurred_at_ms bigint NOT NULL,
      CONSTRAINT ck_credit_amount CHECK(amount_minor > 0 AND amount_minor <= 9007199254740991))`);
    await runner.query(`CREATE TABLE customer_payments (id uuid PRIMARY KEY, ${common},
      cliente_id uuid NOT NULL REFERENCES clientes(cliente_id) ON DELETE RESTRICT,
      amount_minor bigint NOT NULL, occurred_at_ms bigint NOT NULL, method text NOT NULL, reference text,
      CONSTRAINT ck_customer_payment_amount CHECK(amount_minor > 0 AND amount_minor <= 9007199254740991),
      CONSTRAINT ck_customer_payment_method CHECK(method IN ('cash', 'transfer')))`);
    await runner.query(`CREATE TABLE credit_allocations (
      payment_id uuid NOT NULL REFERENCES customer_payments(id) ON DELETE RESTRICT,
      credit_id uuid NOT NULL REFERENCES credit_sales(id) ON DELETE RESTRICT,
      amount_minor bigint NOT NULL, PRIMARY KEY(payment_id, credit_id),
      CONSTRAINT ck_credit_allocation_amount CHECK(amount_minor > 0 AND amount_minor <= 9007199254740991))`);
    await runner.query(
      'CREATE INDEX ix_credit_sales_customer ON credit_sales(cliente_id, occurred_at_ms, id)',
    );
    await runner.query(
      'CREATE INDEX ix_customer_payments_customer ON customer_payments(cliente_id, occurred_at_ms, id)',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = (await runner.query(
      'SELECT EXISTS(SELECT 1 FROM credit_sales UNION ALL SELECT 1 FROM customer_payments UNION ALL SELECT 1 FROM sales WHERE cliente_id IS NOT NULL) AS populated',
    )) as { populated: boolean }[];
    if (rows[0].populated)
      throw new Error(
        'No se puede retirar el esquema con cuentas o ventas de clientes registradas.',
      );
    await runner.query('DROP TABLE credit_allocations');
    await runner.query('DROP TABLE customer_payments');
    await runner.query('DROP TABLE credit_sales');
    await runner.query('ALTER TABLE sales DROP COLUMN cliente_id');
  }
}
