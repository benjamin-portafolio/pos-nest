import { DataSource } from 'typeorm';
import { AddVariantBarcode1790683200000 } from './1790683200000-AddVariantBarcode';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration('AddVariantBarcode con PostgreSQL real', () => {
  jest.setTimeout(30_000);

  const schema = `variant_barcode_it_${process.pid}_${Date.now()}`;
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
        "name" varchar(160),
        "name_key" varchar(320),
        "sale_price_minor" bigint NOT NULL,
        "standard_cost_minor" bigint,
        "sort_order" integer NOT NULL
      )
    `);
    await database.query(`
      INSERT INTO "${schema}"."product_variants" (
        "variant_id", "product_id", "name", "name_key", "sale_price_minor",
        "standard_cost_minor", "sort_order"
      ) VALUES (
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000010', 'Grande', 'grande',
        1000, 200, 0
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

  it('conserva filas, agrega la columna y valida solo dígitos', async () => {
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}"`);
      await new AddVariantBarcode1790683200000().up(runner);
    } finally {
      await runner.release();
    }

    const legacy = await database.query<
      Array<{ name: string | null; barcode: string | null }>
    >(`SELECT name, barcode FROM product_variants`);
    expect(legacy).toEqual([{ name: 'Grande', barcode: null }]);

    // Los ceros a la izquierda se conservan: la columna es texto.
    await database.query(`
      INSERT INTO product_variants (
        variant_id, product_id, barcode, sale_price_minor, sort_order
      ) VALUES (
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000010', '012345678905', 1200, 1
      )
    `);
    expect(
      await database.query<Array<{ barcode: string }>>(
        `SELECT barcode FROM product_variants WHERE sort_order = 1`,
      ),
    ).toEqual([{ barcode: '012345678905' }]);

    await expect(
      database.query(`
        INSERT INTO product_variants (
          variant_id, product_id, barcode, sale_price_minor, sort_order
        ) VALUES (
          '00000000-0000-4000-8000-000000000003',
          '00000000-0000-4000-8000-000000000010', '12-345', 1200, 2
        )
      `),
    ).rejects.toMatchObject({ code: '23514' });

    // No hay unicidad: dos variantes pueden compartir el mismo código.
    await database.query(`
      INSERT INTO product_variants (
        variant_id, product_id, barcode, sale_price_minor, sort_order
      ) VALUES (
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000010', '012345678905', 1300, 3
      )
    `);
  });

  it('revierte la columna y su check con down', async () => {
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}"`);
      await new AddVariantBarcode1790683200000().down(runner);
    } finally {
      await runner.release();
    }

    const columns = await database.query<Array<{ name: string }>>(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = '${schema}' AND table_name = 'product_variants'`,
    );
    expect(columns.map((column) => column.name)).not.toContain('barcode');

    const constraints = await database.query<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint
       WHERE conname = 'ck_product_variants_barcode_digits'
         AND conrelid = '${schema}.product_variants'::regclass`,
    );
    expect(constraints).toHaveLength(0);
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
