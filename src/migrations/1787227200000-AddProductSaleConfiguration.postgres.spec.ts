import { DataSource } from 'typeorm';
import { AddProductSaleConfiguration1787227200000 } from './1787227200000-AddProductSaleConfiguration';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration(
  'AddProductSaleConfiguration con PostgreSQL real',
  () => {
    jest.setTimeout(30_000);

    const schema = `product_sale_migration_it_${process.pid}_${Date.now()}`;
    let administration: DataSource;
    let database: DataSource;

    beforeAll(async () => {
      const connection = postgresConnectionOptions();
      administration = new DataSource(connection);
      await administration.initialize();
      await administration.query(`CREATE SCHEMA "${schema}"`);
      database = new DataSource({ ...connection, schema });
      await database.initialize();
      await database.query(`
        CREATE TABLE "${schema}"."units" (
          "unit_id" uuid PRIMARY KEY
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}"."products" (
          "product_id" uuid PRIMARY KEY,
          "name" varchar(160) NOT NULL
        )
      `);
      await database.query(`
        INSERT INTO "${schema}"."products" ("product_id", "name")
        VALUES ('70000000-0000-4000-8000-000000000001', 'Producto legado')
      `);
    });

    afterAll(async () => {
      if (database?.isInitialized) await database.destroy();
      if (administration?.isInitialized) {
        await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
        await administration.destroy();
      }
    });

    it('migra productos existentes a unit sin perderlos', async () => {
      const migration = new AddProductSaleConfiguration1787227200000();
      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}"`);
        await migration.up(runner);
        await migration.up(runner);
      } finally {
        await runner.release();
      }

      const rows = await database.query<
        Array<{
          name: string;
          sale_mode: string;
          sale_unit_id: string | null;
          price_reference_quantity_atomic: string | null;
        }>
      >(`SELECT * FROM "${schema}"."products"`);
      expect(rows).toEqual([
        expect.objectContaining({
          name: 'Producto legado',
          sale_mode: 'unit',
          sale_unit_id: null,
          price_reference_quantity_atomic: null,
        }),
      ]);
    });
  },
);

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
