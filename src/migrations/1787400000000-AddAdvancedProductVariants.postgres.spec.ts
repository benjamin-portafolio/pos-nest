import { DataSource } from 'typeorm';
import { AddAdvancedProductVariants1787400000000 } from './1787400000000-AddAdvancedProductVariants';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration('AddAdvancedProductVariants con PostgreSQL real', () => {
  jest.setTimeout(30_000);

  const schema = `advanced_variants_it_${process.pid}_${Date.now()}`;
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
      CREATE TABLE "${schema}"."product_variants" (
        "variant_id" uuid PRIMARY KEY,
        "product_id" uuid NOT NULL,
        "sale_price_minor" bigint NOT NULL,
        "is_default" boolean NOT NULL,
        "sort_order" integer NOT NULL
      )
    `);
    await database.query(`
      CREATE TABLE "${schema}"."event_refs" (
        "event_ref_id" uuid PRIMARY KEY,
        "ref_id" varchar(180) NOT NULL
      )
    `);
    await database.query(`
      INSERT INTO "${schema}"."product_variants" (
        "variant_id", "product_id", "sale_price_minor",
        "is_default", "sort_order"
      ) VALUES (
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000010', 1000, true, 0
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

  it('conserva filas, agrega nulls y aplica checks e índice', async () => {
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}"`);
      await new AddAdvancedProductVariants1787400000000().up(runner);
    } finally {
      await runner.release();
    }

    const legacy = await database.query<
      Array<{
        name: string | null;
        name_key: string | null;
        standard_cost_minor: string | null;
      }>
    >(`SELECT name, name_key, standard_cost_minor FROM product_variants`);
    expect(legacy).toEqual([
      { name: null, name_key: null, standard_cost_minor: null },
    ]);

    await expect(
      database.query(`
        INSERT INTO product_variants (
          variant_id, product_id, name, name_key, sale_price_minor,
          standard_cost_minor, is_default, sort_order
        ) VALUES (
          '00000000-0000-4000-8000-000000000002',
          '00000000-0000-4000-8000-000000000010', 'Grande', 'grande',
          1200, -1, false, 1
        )
      `),
    ).rejects.toMatchObject({ code: '23514' });

    await database.query(`
      INSERT INTO product_variants (
        variant_id, product_id, name, name_key, sale_price_minor,
        standard_cost_minor, is_default, sort_order
      ) VALUES (
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000010', 'Grande', 'grande',
        1200, 0, false, 1
      )
    `);
    await expect(
      database.query(`
        INSERT INTO product_variants (
          variant_id, product_id, name, name_key, sale_price_minor,
          is_default, sort_order
        ) VALUES (
          '00000000-0000-4000-8000-000000000004',
          '00000000-0000-4000-8000-000000000010', 'GRANDE', 'grande',
          1300, false, 2
        )
      `),
    ).rejects.toMatchObject({ code: '23505' });
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
