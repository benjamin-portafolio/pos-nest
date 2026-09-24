import { DataSource } from 'typeorm';
import { AddTransferSales1790208000000 } from './1790208000000-AddTransferSales';
const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('migración de transferencias', () => {
  it('preserva efectivo histórico, restricciones y protege downgrade', async () => {
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
      await runner.query(`CREATE SCHEMA transfer_migration_${process.pid}`);
      await runner.query(
        `SET LOCAL search_path TO transfer_migration_${process.pid}`,
      );
      await runner.query(`CREATE TABLE sale_payments(payment_id integer PRIMARY KEY,
        sale_id integer UNIQUE, method varchar NOT NULL DEFAULT 'cash', currency varchar NOT NULL,
        amount_minor bigint NOT NULL, received_minor bigint NOT NULL, change_minor bigint NOT NULL,
        CONSTRAINT ck_cash_payment CHECK(amount_minor >= 0 AND received_minor >= amount_minor AND
        received_minor <= 9007199254740991 AND change_minor = received_minor - amount_minor))`);
      await runner.query(
        "INSERT INTO sale_payments VALUES(1,1,'cash','MXN',100,200,100)",
      );
      const migration = new AddTransferSales1790208000000();
      await migration.up(runner);
      expect(
        await runner.query('SELECT method, reference FROM sale_payments'),
      ).toEqual([{ method: 'cash', reference: null }]);
      await runner.query(
        "INSERT INTO sale_payments VALUES(2,2,'transfer','MXN',100,100,0,'BANK')",
      );
      await expect(migration.down(runner)).rejects.toThrow(
        'transferencias o referencias',
      );
      for (const sql of [
        'UPDATE sale_payments SET received_minor=200,change_minor=100 WHERE payment_id=2',
        "UPDATE sale_payments SET method='credit' WHERE payment_id=2",
        "UPDATE sale_payments SET currency='USD' WHERE payment_id=2",
        "UPDATE sale_payments SET reference=repeat('x',501) WHERE payment_id=2",
        'UPDATE sale_payments SET sale_id=1 WHERE payment_id=2',
      ]) {
        await runner.query('SAVEPOINT invalid');
        await expect(runner.query(sql)).rejects.toThrow();
        await runner.query('ROLLBACK TO SAVEPOINT invalid');
      }
      await runner.query('DELETE FROM sale_payments WHERE payment_id=2');
      await migration.down(runner);
      expect(await runner.query('SELECT method FROM sale_payments')).toEqual([
        { method: 'cash' },
      ]);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await db.destroy();
    }
  });
});
