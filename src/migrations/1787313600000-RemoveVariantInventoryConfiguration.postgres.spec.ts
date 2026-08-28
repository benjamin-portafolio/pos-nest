import { DataSource } from 'typeorm';
import { RemoveVariantInventoryConfiguration1787313600000 } from './1787313600000-RemoveVariantInventoryConfiguration';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration(
  'RemoveVariantInventoryConfiguration con PostgreSQL real',
  () => {
    jest.setTimeout(30_000);

    const schema = `remove_variant_inventory_it_${process.pid}_${Date.now()}`;
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
        CREATE TABLE "${schema}"."products" (
          "product_id" uuid PRIMARY KEY,
          "inventory_mode" varchar(24)
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}"."product_variants" (
          "variant_id" uuid PRIMARY KEY,
          "inventory_behavior" varchar(16),
          "inventory_enabled" boolean,
          "direct_inventory_item_id" uuid,
          "direct_quantity_atomic" bigint
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}"."recipe_components" (
          "variant_id" uuid NOT NULL,
          "inventory_item_id" uuid NOT NULL,
          "quantity_atomic" bigint NOT NULL
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}"."inventory_movements" (
          "movement_id" uuid PRIMARY KEY
        )
      `);
    });

    afterAll(async () => {
      if (database?.isInitialized) await database.destroy();
      if (administration?.isInitialized) {
        await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
        await administration.destroy();
      }
    });

    it('elimina tabla y columnas de inventario asociadas a variantes', async () => {
      const migration = new RemoveVariantInventoryConfiguration1787313600000();
      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}"`);
        await migration.up(runner);
        await migration.up(runner);
      } finally {
        await runner.release();
      }

      const columns = await database.query<Array<{ column_name: string }>>(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name IN ('products', 'product_variants')
        `,
        [schema],
      );
      const recipeTable = await database.query<
        Array<{ exists: string | null }>
      >(`SELECT to_regclass($1) AS exists`, [`${schema}.recipe_components`]);

      expect(columns.map((row) => row.column_name)).toEqual(
        expect.arrayContaining(['product_id', 'variant_id']),
      );
      expect(columns.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining([
          'inventory_mode',
          'inventory_behavior',
          'inventory_enabled',
          'direct_inventory_item_id',
          'direct_quantity_atomic',
        ]),
      );
      expect(recipeTable[0]?.exists).toBeNull();
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
