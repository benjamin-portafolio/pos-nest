import { DataSource } from 'typeorm';
import { AddDirectVariantInventoryTracking1787745600000 } from './1787745600000-AddDirectVariantInventoryTracking';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration(
  'AddDirectVariantInventoryTracking con PostgreSQL real',
  () => {
    jest.setTimeout(30_000);

    const schema = `direct_inventory_it_${process.pid}_${Date.now()}`;
    let administration: DataSource;
    let database: DataSource;

    beforeAll(async () => {
      const connection = postgresConnectionOptions();
      administration = new DataSource(connection);
      await administration.initialize();
      await administration.query(`CREATE SCHEMA "${schema}"`);
      database = new DataSource({
        ...connection,
        schema,
        extra: { options: `-c search_path=${schema}` },
      });
      await database.initialize();
      await database.query(`
        CREATE TABLE inventory_items (
          inventory_item_id uuid PRIMARY KEY
        )
      `);
      await database.query(`
        CREATE TABLE product_variants (
          variant_id uuid PRIMARY KEY
        )
      `);
      await database.query(`
        INSERT INTO inventory_items (inventory_item_id) VALUES
          ('00000000-0000-4000-8000-000000000010'),
          ('00000000-0000-4000-8000-000000000011')
      `);
      await database.query(`
        INSERT INTO product_variants (variant_id) VALUES
          ('00000000-0000-4000-8000-000000000001'),
          ('00000000-0000-4000-8000-000000000002')
      `);
    });

    afterAll(async () => {
      if (database?.isInitialized) await database.destroy();
      if (administration?.isInitialized) {
        await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
        await administration.destroy();
      }
    });

    it('agrega un vínculo opcional, único y protegido contra borrado', async () => {
      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}"`);
        await new AddDirectVariantInventoryTracking1787745600000().up(runner);
      } finally {
        await runner.release();
      }

      const legacy = await database.query<
        Array<{ inventory_item_id: string | null }>
      >(`SELECT inventory_item_id FROM product_variants ORDER BY variant_id`);
      expect(legacy).toEqual([
        { inventory_item_id: null },
        { inventory_item_id: null },
      ]);

      await database.query(`
        UPDATE product_variants
        SET inventory_item_id = '00000000-0000-4000-8000-000000000010'
        WHERE variant_id = '00000000-0000-4000-8000-000000000001'
      `);
      await expect(
        database.query(`
          UPDATE product_variants
          SET inventory_item_id = '00000000-0000-4000-8000-000000000010'
          WHERE variant_id = '00000000-0000-4000-8000-000000000002'
        `),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        database.query(`
          DELETE FROM inventory_items
          WHERE inventory_item_id = '00000000-0000-4000-8000-000000000010'
        `),
      ).rejects.toHaveProperty(
        'code',
        expect.stringMatching(/^(23503|23001)$/),
      );
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
