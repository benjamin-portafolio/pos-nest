import { DataSource } from 'typeorm';
import { RemoveVariantDefault1788998400000 } from './1788998400000-RemoveVariantDefault';

const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

integration('eliminación de is_default en PostgreSQL', () => {
  it('conserva filas y relaciones, admite repetir up y reconstruye la regla anterior al revertir', async () => {
    const database = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    });
    await database.initialize();
    const runner = database.createQueryRunner();
    await runner.connect();
    const schema = `remove_default_it_${process.pid}_${Date.now()}`;
    try {
      await runner.startTransaction();
      await runner.query(`CREATE SCHEMA "${schema}"`);
      await runner.query(`SET LOCAL search_path TO "${schema}"`);
      await runner.query(`CREATE TABLE product_variants (
        variant_id text PRIMARY KEY, product_id text NOT NULL,
        sort_order integer NOT NULL, active boolean NOT NULL,
        sale_price_minor bigint NOT NULL, is_default boolean NOT NULL
      )`);
      await runner.query(`CREATE UNIQUE INDEX ux_product_variants_active_default
        ON product_variants(product_id) WHERE active AND is_default`);
      await runner.query(`CREATE TABLE recipe_components (
        variant_id text REFERENCES product_variants(variant_id), quantity integer
      )`);
      await runner.query(`INSERT INTO product_variants VALUES
        ('old', 'p', 0, false, 500, false),
        ('first', 'p', 0, true, 1000, true),
        ('second', 'p', 1, true, 2000, false)`);
      await runner.query(`INSERT INTO recipe_components VALUES ('first', 2)`);
      const migration = new RemoveVariantDefault1788998400000();
      await migration.up(runner);
      await migration.up(runner);
      expect(
        await runner.query(
          `SELECT * FROM product_variants ORDER BY variant_id`,
        ),
      ).toEqual([
        {
          variant_id: 'first',
          product_id: 'p',
          sort_order: 0,
          active: true,
          sale_price_minor: '1000',
        },
        {
          variant_id: 'old',
          product_id: 'p',
          sort_order: 0,
          active: false,
          sale_price_minor: '500',
        },
        {
          variant_id: 'second',
          product_id: 'p',
          sort_order: 1,
          active: true,
          sale_price_minor: '2000',
        },
      ]);
      expect(await runner.query(`SELECT * FROM recipe_components`)).toEqual([
        { variant_id: 'first', quantity: 2 },
      ]);
      await migration.down(runner);
      expect(
        await runner.query(
          `SELECT variant_id FROM product_variants WHERE is_default`,
        ),
      ).toEqual([{ variant_id: 'first' }]);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
      await database.destroy();
    }
  });
});
