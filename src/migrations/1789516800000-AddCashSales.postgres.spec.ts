import { DataSource } from 'typeorm';
import { AddCashSales1789516800000 } from './1789516800000-AddCashSales';
const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('migración de ventas', () => {
  it('crea relaciones sin perder inventario y bloquea downgrade con cobros', async () => {
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
      const schema = `cash_migration_${process.pid}_${Date.now()}`;
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);
      await runner.query(
        'CREATE TABLE product_variants (variant_id uuid PRIMARY KEY)',
      );
      await runner.query(
        'CREATE TABLE inventory_movements (movement_id uuid PRIMARY KEY, sale_item_id uuid, inventory_item_id uuid, event_id uuid, movement_type text, quantity_delta_atomic bigint, total_cost_minor bigint)',
      );
      await runner.query(
        "INSERT INTO inventory_movements VALUES ('00000000-0000-4000-8000-000000000001',null,null,null,'initial_balance',5,null)",
      );
      const migration = new AddCashSales1789516800000();
      await migration.up(runner);
      expect(
        await runner.query(
          'SELECT quantity_delta_atomic FROM inventory_movements',
        ),
      ).toEqual([{ quantity_delta_atomic: '5' }]);
      await runner.query(
        "INSERT INTO sales(sale_id,user_id,device_id,total_minor,currency,created_at_local) VALUES ('00000000-0000-4000-8000-000000000002','u','d',100,'MXN',now())",
      );
      await expect(migration.down(runner)).rejects.toThrow('ventas cobradas');
      await runner.query('DELETE FROM sales');
      await migration.down(runner);
      expect(
        await runner.query(
          'SELECT quantity_delta_atomic FROM inventory_movements',
        ),
      ).toEqual([{ quantity_delta_atomic: '5' }]);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await db.destroy();
    }
  });
});
