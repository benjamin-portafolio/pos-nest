import { DataSource } from 'typeorm';
import { CreateInventoryResources1787140800000 } from './1787140800000-CreateInventoryResources';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration('CreateInventoryResources con PostgreSQL real', () => {
  jest.setTimeout(30_000);

  const schema = `inventory_migration_it_${process.pid}_${Date.now()}`;
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
        "name" varchar(160) NOT NULL
      )
    `);
    await database.query(`
      CREATE TABLE "${schema}"."product_variants" (
        "variant_id" uuid PRIMARY KEY,
        "product_id" uuid NOT NULL REFERENCES "${schema}"."products"("product_id")
      )
    `);
    await database.query(`
      INSERT INTO "${schema}"."products" ("product_id", "name")
      VALUES ('70000000-0000-4000-8000-000000000001', 'Producto legado')
    `);
    await database.query(`
      INSERT INTO "${schema}"."product_variants" (
        "variant_id", "product_id"
      ) VALUES (
        '71000000-0000-4000-8000-000000000001',
        '70000000-0000-4000-8000-000000000001'
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

  it('crea recursos y unidades sin modificar las variantes', async () => {
    const migration = new CreateInventoryResources1787140800000();
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}"`);
      await migration.up(runner);
      await migration.up(runner);
    } finally {
      await runner.release();
    }

    const units = await database.query<
      Array<{ code: string; active: boolean }>
    >(`SELECT "code", "active" FROM "${schema}"."units" ORDER BY "code"`);
    const variantColumns = await database.query<Array<{ column_name: string }>>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'product_variants'
        ORDER BY ordinal_position
      `,
      [schema],
    );
    const itemCount = await database.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM "${schema}"."inventory_items"`,
    );

    expect(units).toHaveLength(5);
    expect(units.every((unit) => unit.active)).toBe(true);
    expect(variantColumns.map((row) => row.column_name)).toEqual([
      'variant_id',
      'product_id',
    ]);
    expect(itemCount[0]?.count).toBe('0');
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
