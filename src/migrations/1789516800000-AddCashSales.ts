import { MigrationInterface, QueryRunner } from 'typeorm';

/** Aplicar únicamente mediante el proceso explícito de migraciones del servidor. */
export class AddCashSales1789516800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const common = `active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
      created_event_id uuid, last_event_id uuid, last_server_sequence bigint,
      created_at_server timestamptz(3) NOT NULL DEFAULT now(), updated_at_server timestamptz(3) NOT NULL DEFAULT now()`;
    await runner.query(`CREATE TABLE sales (sale_id uuid PRIMARY KEY, ${common},
      user_id varchar(120) NOT NULL, device_id varchar(120) NOT NULL,
      status varchar NOT NULL DEFAULT 'confirmada', total_minor bigint NOT NULL,
      currency varchar(3) NOT NULL, created_at_local timestamptz NOT NULL,
      CONSTRAINT ck_sales_total CHECK(total_minor BETWEEN 0 AND 9007199254740991))`);
    await runner.query(`CREATE TABLE sale_items (sale_item_id uuid PRIMARY KEY, ${common},
      sale_id uuid NOT NULL REFERENCES sales(sale_id) ON DELETE RESTRICT,
      variant_id uuid NOT NULL REFERENCES product_variants(variant_id) ON DELETE RESTRICT,
      total_minor bigint NOT NULL, sort_order integer NOT NULL, snapshot jsonb NOT NULL)`);
    await runner.query(
      'CREATE INDEX ix_sale_items_sale ON sale_items(sale_id)',
    );
    await runner.query(
      'CREATE INDEX ix_sale_items_variant ON sale_items(variant_id)',
    );
    await runner.query(`CREATE TABLE sale_payments (payment_id uuid PRIMARY KEY, ${common},
      sale_id uuid NOT NULL UNIQUE REFERENCES sales(sale_id) ON DELETE RESTRICT,
      method varchar NOT NULL DEFAULT 'cash', currency varchar(3) NOT NULL,
      amount_minor bigint NOT NULL, received_minor bigint NOT NULL, change_minor bigint NOT NULL,
      CONSTRAINT ck_cash_payment CHECK(amount_minor >= 0 AND received_minor >= amount_minor AND
        received_minor <= 9007199254740991 AND change_minor = received_minor - amount_minor))`);
    // Si existiesen referencias legadas huérfanas, fallar; nunca descartarlas.
    await runner.query(`ALTER TABLE inventory_movements ADD CONSTRAINT fk_movement_sale_item
      FOREIGN KEY(sale_item_id) REFERENCES sale_items(sale_item_id) ON DELETE RESTRICT`);
    await runner.query(`ALTER TABLE inventory_movements ADD CONSTRAINT ck_sale_consumption CHECK(
      movement_type <> 'sale_consumption' OR (sale_item_id IS NOT NULL AND quantity_delta_atomic < 0 AND total_cost_minor IS NULL))`);
    await runner.query(
      `CREATE UNIQUE INDEX ux_sale_consumption ON inventory_movements(sale_item_id, inventory_item_id) WHERE movement_type = 'sale_consumption'`,
    );
    await runner.query(
      'CREATE INDEX ix_movements_event ON inventory_movements(event_id)',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = (await runner.query(
      'SELECT EXISTS(SELECT 1 FROM sales) AS exists',
    )) as { exists: boolean }[];
    if (rows[0].exists)
      throw new Error('No se puede retirar el esquema con ventas cobradas.');
    await runner.query('DROP INDEX ix_movements_event');
    await runner.query('DROP INDEX ux_sale_consumption');
    await runner.query(
      'ALTER TABLE inventory_movements DROP CONSTRAINT ck_sale_consumption',
    );
    await runner.query(
      'ALTER TABLE inventory_movements DROP CONSTRAINT fk_movement_sale_item',
    );
    await runner.query('DROP TABLE sale_payments');
    await runner.query('DROP TABLE sale_items');
    await runner.query('DROP TABLE sales');
  }
}
