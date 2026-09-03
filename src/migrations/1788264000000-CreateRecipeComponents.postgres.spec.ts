import { DataSource } from 'typeorm';
import { CreateRecipeComponents1788264000000 } from './1788264000000-CreateRecipeComponents';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration('CreateRecipeComponents con PostgreSQL real', () => {
  jest.setTimeout(30_000);

  const schema = `recipe_components_it_${process.pid}_${Date.now()}`;
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
      CREATE TABLE "${schema}".product_variants (
        variant_id uuid PRIMARY KEY
      )
    `);
    await database.query(`
      CREATE TABLE "${schema}".inventory_items (
        inventory_item_id uuid PRIMARY KEY
      )
    `);
    await database.query(`
      INSERT INTO "${schema}".product_variants (variant_id)
      VALUES ('00000000-0000-4000-8000-000000000001')
    `);
    await database.query(`
      INSERT INTO "${schema}".inventory_items (inventory_item_id)
      VALUES ('00000000-0000-4000-8000-000000000010')
    `);
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (administration?.isInitialized) {
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.destroy();
    }
  });

  it('crea PK, FKs, límites de cantidad e índice de ingredientes', async () => {
    const runner = database.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}"`);
      const migration = new CreateRecipeComponents1788264000000();
      await migration.up(runner);
      await migration.up(runner);
    } finally {
      await runner.release();
    }

    await database.query(`
      INSERT INTO "${schema}".recipe_components (
        variant_id,
        inventory_item_id,
        quantity_atomic
      ) VALUES (
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000010',
        9007199254740991
      )
    `);
    await expect(
      database.query(`
        INSERT INTO "${schema}".recipe_components (
          variant_id,
          inventory_item_id,
          quantity_atomic
        ) VALUES (
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000010',
          1
        )
      `),
    ).rejects.toMatchObject({ code: '23505' });
    await database.query(`DELETE FROM "${schema}".recipe_components`);
    await expect(
      database.query(`
        INSERT INTO "${schema}".recipe_components (
          variant_id,
          inventory_item_id,
          quantity_atomic
        ) VALUES (
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000010',
          0
        )
      `),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      database.query(`
        INSERT INTO "${schema}".recipe_components (
          variant_id,
          inventory_item_id,
          quantity_atomic
        ) VALUES (
          '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-000000000010',
          9007199254740992
        )
      `),
    ).rejects.toMatchObject({ code: '23514' });

    await database.query(`
      INSERT INTO "${schema}".recipe_components (
        variant_id,
        inventory_item_id,
        quantity_atomic
      ) VALUES (
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000010',
        250
      )
    `);
    await expect(
      database.query(`
        DELETE FROM "${schema}".inventory_items
        WHERE inventory_item_id = '00000000-0000-4000-8000-000000000010'
      `),
    ).rejects.toMatchObject({ code: '23001' });
    await database.query(`
      DELETE FROM "${schema}".product_variants
      WHERE variant_id = '00000000-0000-4000-8000-000000000001'
    `);
    expect(
      await database.query<Array<{ count: string }>>(
        `SELECT count(*) FROM "${schema}".recipe_components`,
      ),
    ).toEqual([{ count: '0' }]);

    const indexes = await database.query<Array<{ indexname: string }>>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = '${schema}'
        AND tablename = 'recipe_components'
    `);
    expect(indexes.map((row) => row.indexname)).toContain(
      'ix_recipe_components_inventory_item',
    );
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
