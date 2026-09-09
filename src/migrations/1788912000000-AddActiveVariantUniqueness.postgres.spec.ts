import { DataSource } from 'typeorm';
import { AddActiveVariantUniqueness1788912000000 } from './1788912000000-AddActiveVariantUniqueness';
const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('unicidad de variantes activas en PostgreSQL', () => {
  it('migra constraints previas, permite historial duplicado y mantiene unicidad activa', async () => {
    const database = new DataSource(postgresConnectionOptions());
    await database.initialize();
    const runner = database.createQueryRunner();
    await runner.connect();
    const schema = `active_variant_it_${process.pid}_${Date.now()}`;
    try {
      await runner.startTransaction();
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);
      await runner.query(`CREATE TABLE product_variants (
        variant_id text PRIMARY KEY, product_id text NOT NULL,
        name_key text, sort_order integer NOT NULL, active boolean NOT NULL,
        CONSTRAINT ux_product_variants_product_sort UNIQUE (product_id, sort_order)
      )`);
      await runner.query(
        `CREATE UNIQUE INDEX ux_product_variants_product_name_key ON product_variants (product_id, name_key) WHERE name_key IS NOT NULL`,
      );
      await runner.query(
        `INSERT INTO product_variants VALUES ('old', 'product', 'grande', 0, false)`,
      );
      await new AddActiveVariantUniqueness1788912000000().up(runner);
      await runner.query(
        `INSERT INTO product_variants VALUES ('new', 'product', 'grande', 0, true)`,
      );
      expect(
        await runner.query(
          `SELECT variant_id FROM product_variants ORDER BY variant_id`,
        ),
      ).toEqual([{ variant_id: 'new' }, { variant_id: 'old' }]);
      await expect(
        runner.query(
          `INSERT INTO product_variants VALUES ('duplicate', 'product', 'grande', 1, true)`,
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await database.destroy();
    }
  });
});

function postgresConnectionOptions() {
  const required = [
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_USER',
    'DATABASE_PASSWORD',
    'DATABASE_NAME',
  ] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Falta ${key} para la integración.`);
  }
  return {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  };
}
