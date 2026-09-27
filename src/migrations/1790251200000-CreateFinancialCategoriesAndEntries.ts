import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Categorías financieras y registros de ingresos/gastos adicionales.
 * Aplicar únicamente mediante el proceso explícito de migraciones del servidor.
 */
export class CreateFinancialCategoriesAndEntries1790251200000
  implements MigrationInterface
{
  async up(runner: QueryRunner): Promise<void> {
    const common = `active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
      created_event_id uuid, last_event_id uuid, last_server_sequence bigint,
      created_at_server timestamptz(3) NOT NULL DEFAULT now(), updated_at_server timestamptz(3) NOT NULL DEFAULT now()`;
    await runner.query(`CREATE TABLE financial_categories (id uuid PRIMARY KEY, ${common},
      name varchar(100) NOT NULL, direction text NOT NULL, nature text NOT NULL,
      CONSTRAINT ck_financial_categories_name CHECK(char_length(name) BETWEEN 1 AND 100),
      CONSTRAINT ck_financial_categories_direction CHECK(direction IN ('in', 'out')),
      CONSTRAINT ck_financial_categories_nature CHECK(nature IN ('operating', 'capital', 'asset_purchase', 'inventory_purchase', 'financing')),
      CONSTRAINT ck_financial_categories_nature_direction CHECK(NOT (direction = 'in' AND nature IN ('asset_purchase', 'inventory_purchase'))))`);
    await runner.query(`CREATE TABLE financial_entries (id uuid PRIMARY KEY, ${common},
      category_id uuid NOT NULL REFERENCES financial_categories(id) ON DELETE RESTRICT,
      category_name_snapshot varchar(100) NOT NULL, direction text NOT NULL, nature text NOT NULL,
      amount_minor bigint NOT NULL, currency varchar(3) NOT NULL, method text NOT NULL,
      occurred_at_ms bigint NOT NULL, notes text, reference text,
      CONSTRAINT ck_financial_entries_category_name CHECK(char_length(category_name_snapshot) BETWEEN 1 AND 100),
      CONSTRAINT ck_financial_entries_direction CHECK(direction IN ('in', 'out')),
      CONSTRAINT ck_financial_entries_nature CHECK(nature IN ('operating', 'capital', 'asset_purchase', 'inventory_purchase', 'financing')),
      CONSTRAINT ck_financial_entries_nature_direction CHECK(NOT (direction = 'in' AND nature IN ('asset_purchase', 'inventory_purchase'))),
      CONSTRAINT ck_financial_entries_amount CHECK(amount_minor > 0 AND amount_minor <= 9007199254740991),
      CONSTRAINT ck_financial_entries_currency CHECK(currency = 'MXN'),
      CONSTRAINT ck_financial_entries_method CHECK(method IN ('cash', 'transfer')),
      CONSTRAINT ck_financial_entries_occurred CHECK(occurred_at_ms > 0 AND occurred_at_ms <= 9007199254740991),
      CONSTRAINT ck_financial_entries_notes CHECK(notes IS NULL OR char_length(notes) <= 500),
      CONSTRAINT ck_financial_entries_reference CHECK(reference IS NULL OR char_length(reference) <= 500))`);
    await runner.query(
      'CREATE INDEX ix_financial_entries_period ON financial_entries(occurred_at_ms, id)',
    );
    await runner.query(
      'CREATE INDEX ix_financial_entries_category ON financial_entries(category_id, occurred_at_ms, id)',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = (await runner.query(
      'SELECT EXISTS(SELECT 1 FROM financial_entries UNION ALL SELECT 1 FROM financial_categories) AS populated',
    )) as { populated: boolean }[];
    if (rows[0].populated)
      throw new Error(
        'No se puede retirar el esquema con categorías o registros financieros.',
      );
    await runner.query('DROP INDEX ix_financial_entries_period');
    await runner.query('DROP INDEX ix_financial_entries_category');
    await runner.query('DROP TABLE financial_entries');
    await runner.query('DROP TABLE financial_categories');
  }
}