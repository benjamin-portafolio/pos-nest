import { DataSource } from 'typeorm';
import { AddCustomerCredit1790035200000 } from './1790035200000-AddCustomerCredit';
const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('migración de crédito', () => {
  it('preserva ventas, crea relaciones y protege downgrade con datos', async () => {
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
      const schema = `credit_migration_${process.pid}_${Date.now()}`;
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);
      await runner.query('CREATE TABLE clientes(cliente_id uuid PRIMARY KEY)');
      await runner.query('CREATE TABLE sales(sale_id uuid PRIMARY KEY)');
      const c = '00000000-0000-4000-8000-000000000001',
        v = '00000000-0000-4000-8000-000000000002';
      await runner.query('INSERT INTO clientes VALUES ($1)', [c]);
      await runner.query('INSERT INTO sales VALUES ($1)', [v]);
      const migration = new AddCustomerCredit1790035200000();
      await migration.up(runner);
      expect(await runner.query('SELECT sale_id FROM sales')).toEqual([
        { sale_id: v },
      ]);
      await runner.query(
        'INSERT INTO credit_sales(id,sale_id,cliente_id,amount_minor,occurred_at_ms) VALUES($1,$1,$2,2000,1000)',
        [v, c],
      );
      await expect(migration.down(runner)).rejects.toThrow('cuentas o ventas');
      await runner.query('DELETE FROM credit_sales');
      await migration.down(runner);
      expect(await runner.query('SELECT sale_id FROM sales')).toEqual([
        { sale_id: v },
      ]);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await db.destroy();
    }
  });
});
