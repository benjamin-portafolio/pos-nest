import { DataSource } from 'typeorm';
import { CreateFinancialCategoriesAndEntries1790251200000 } from './1790251200000-CreateFinancialCategoriesAndEntries';
const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('migración de categorías y registros financieros', () => {
  it('preserva datos previos, crea restricciones/índices y protege downgrade', async () => {
    const db = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    });
    await db.initialize();
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      const schema = `financial_migration_${process.pid}_${Date.now()}`;
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);
      // Esquema existente representativo: conservarlo intacto tras la migración.
      await runner.query(
        'CREATE TABLE sales(sale_id uuid PRIMARY KEY, total_minor bigint NOT NULL)',
      );
      await runner.query(
        'CREATE TABLE sale_payments(payment_id uuid PRIMARY KEY, sale_id uuid NOT NULL REFERENCES sales(sale_id) ON DELETE RESTRICT, method varchar NOT NULL, amount_minor bigint NOT NULL)',
      );
      const sale = '00000000-0000-4000-8000-000000000001',
        payment = '00000000-0000-4000-8000-000000000002';
      await runner.query('INSERT INTO sales VALUES ($1, 12500)', [sale]);
      await runner.query(
        'INSERT INTO sale_payments VALUES ($1, $2, $3, 12500)',
        [payment, sale, 'cash'],
      );

      const migration = new CreateFinancialCategoriesAndEntries1790251200000();
      await migration.up(runner);
      expect(await runner.query('SELECT sale_id, total_minor FROM sales')).toEqual([
        { sale_id: sale, total_minor: '12500' },
      ]);
      expect(
        await runner.query(
          "SELECT tablename FROM pg_tables WHERE schemaname = '" +
            schema +
            "' ORDER BY tablename",
        ),
      ).toEqual([
        { tablename: 'financial_categories' },
        { tablename: 'financial_entries' },
        { tablename: 'sale_payments' },
        { tablename: 'sales' },
      ]);
      const indexes = (await runner.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = '" +
          schema +
          "' AND tablename = 'financial_entries' ORDER BY indexname",
      )) as { indexname: string }[];
      expect(indexes.map((row) => row.indexname)).toEqual([
        'financial_entries_pkey',
        'ix_financial_entries_category',
        'ix_financial_entries_period',
      ]);

      const category = '11111111-1111-4111-8111-111111111111',
        entry = '33333333-3333-4333-8333-333333333333';
      await runner.query(
        'INSERT INTO financial_categories(id,name,direction,nature) VALUES($1,$2,$3,$4)',
        [category, 'Renta', 'out', 'operating'],
      );
      await runner.query(
        `INSERT INTO financial_entries(id,category_id,category_name_snapshot,direction,nature,
          amount_minor,currency,method,occurred_at_ms,notes,reference)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL)`,
        [entry, category, 'Renta', 'out', 'operating', 50000, 'MXN', 'cash', 1789041600000, 'Renta de septiembre'],
      );
      expect(
        await runner.query('SELECT amount_minor, method FROM financial_entries'),
      ).toEqual([{ amount_minor: '50000', method: 'cash' }]);

      const invalid = [
        "INSERT INTO financial_categories(id,name,direction,nature) VALUES('a','x','bad','operating')",
        "INSERT INTO financial_categories(id,name,direction,nature) VALUES('a','x','in','otra')",
        "INSERT INTO financial_categories(id,name,direction,nature) VALUES('a','x','in','asset_purchase')",
        "INSERT INTO financial_categories(id,name,direction,nature) VALUES('a',repeat('x',101),'in','operating')",
        `INSERT INTO financial_entries(id,category_id,category_name_snapshot,direction,nature,
          amount_minor,currency,method,occurred_at_ms) VALUES('b','${category}','Renta','out','operating',0,'MXN','cash',1)`,
        `INSERT INTO financial_entries(id,category_id,category_name_snapshot,direction,nature,
          amount_minor,currency,method,occurred_at_ms) VALUES('b','${category}','Renta','out','operating',50000,'USD','cash',1)`,
        `INSERT INTO financial_entries(id,category_id,category_name_snapshot,direction,nature,
          amount_minor,currency,method,occurred_at_ms) VALUES('b','${category}','Renta','out','operating',50000,'MXN','debito',1)`,
        `INSERT INTO financial_entries(id,category_id,category_name_snapshot,direction,nature,
          amount_minor,currency,method,occurred_at_ms) VALUES('b','${category}','Renta','out','operating',50000,'MXN','cash',0)`,
        `INSERT INTO financial_entries(id,category_id,category_name_snapshot,direction,nature,
          amount_minor,currency,method,occurred_at_ms,notes) VALUES('b','${category}','Renta','in','operating',50000,'MXN','cash',1,repeat('x',501))`,
      ];
      for (const sql of invalid) {
        await runner.query('SAVEPOINT invalid');
        await expect(runner.query(sql)).rejects.toThrow();
        await runner.query('ROLLBACK TO SAVEPOINT invalid');
      }
      // FK de categoría: no se puede borrar una categoría con registros.
      await runner.query('SAVEPOINT restrict_fk');
      await expect(
        runner.query('DELETE FROM financial_categories WHERE id = $1', [
          category,
        ]),
      ).rejects.toThrow();
      await runner.query('ROLLBACK TO SAVEPOINT restrict_fk');

      await expect(migration.down(runner)).rejects.toThrow(
        'categorías o registros',
      );
      await runner.query('DELETE FROM financial_entries');
      await runner.query('DELETE FROM financial_categories');
      await migration.down(runner);
      expect(await runner.query('SELECT sale_id FROM sales')).toEqual([
        { sale_id: sale },
      ]);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await db.destroy();
    }
  });
});