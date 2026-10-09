import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CreateProductSuppliers1791417600000 } from './1791417600000-CreateProductSuppliers';

const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('Migración proveedores sobre esquema anterior con datos', () => {
  const schema = `suppliers_migration_${process.pid}_${Date.now()}`;
  let admin: DataSource, db: DataSource;
  const product = randomUUID(),
    variant = randomUUID(),
    supplier = randomUUID();
  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    };
    admin = new DataSource(connection);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      ...connection,
      schema,
      extra: { options: `-c search_path=${schema},public` },
      migrations: [CreateProductSuppliers1791417600000],
    });
    await db.initialize();
    await db.query(
      'CREATE TABLE products (product_id uuid PRIMARY KEY, name text NOT NULL)',
    );
    await db.query(
      'CREATE TABLE product_variants (variant_id uuid PRIMARY KEY, product_id uuid REFERENCES products ON DELETE CASCADE, sale_price_minor bigint NOT NULL, active boolean NOT NULL)',
    );
    await db.query(
      'CREATE TABLE events (event_id uuid PRIMARY KEY, payload jsonb NOT NULL)',
    );
    await db.query(
      'CREATE TABLE recipe_components (variant_id uuid REFERENCES product_variants ON DELETE CASCADE, quantity_atomic bigint NOT NULL)',
    );
    await db.query('INSERT INTO products VALUES ($1, $2)', [product, 'Previo']);
    await db.query('INSERT INTO product_variants VALUES ($1, $2, 2500, true)', [
      variant,
      product,
    ]);
    await db.query('INSERT INTO events VALUES ($1, $2)', [
      randomUUID(),
      { variants: [{ variant_id: variant }] },
    ]);
    await db.query('INSERT INTO recipe_components VALUES ($1, 1000)', [
      variant,
    ]);
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('TypeORM runMigrations conserva literalmente filas previas y no inventa relaciones', async () => {
    const snapshot = async () =>
      Promise.all(
        ['products', 'product_variants', 'events', 'recipe_components'].map(
          (table) => db.query(`SELECT * FROM "${table}"`),
        ),
      );
    const before = await snapshot();
    expect(await db.runMigrations()).toHaveLength(1);
    expect(await db.runMigrations()).toHaveLength(0);
    const runner = db.createQueryRunner();
    try {
      await new CreateProductSuppliers1791417600000().up(runner);
    } finally {
      await runner.release();
    }
    expect(await snapshot()).toEqual(before);
    expect(await db.query('SELECT * FROM suppliers')).toEqual([]);
    expect(await db.query('SELECT * FROM variant_suppliers')).toEqual([]);
    await db.query(
      'INSERT INTO suppliers (supplier_id, name) VALUES ($1, $2)',
      [supplier, 'Norte'],
    );
  });
  it('sin unicidad de nombre y CHECK nombre requerido', async () => {
    await db.query(
      'INSERT INTO suppliers (supplier_id, name) VALUES ($1, $2)',
      [randomUUID(), 'Norte'],
    );
    for (const name of ['', ' ', '\n\t\r'])
      await expect(
        db.query('INSERT INTO suppliers (supplier_id, name) VALUES ($1, $2)', [
          randomUUID(),
          name,
        ]),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });
  it('tipos bigint y PK compuesta, sin versiones de relación', async () => {
    const columns = await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'variant_suppliers' ORDER BY column_name",
      [schema],
    );
    expect(columns).toEqual([
      { column_name: 'quoted_at_ms', data_type: 'bigint' },
      { column_name: 'quoted_price_minor', data_type: 'bigint' },
      { column_name: 'supplier_id', data_type: 'uuid' },
      { column_name: 'variant_id', data_type: 'uuid' },
    ]);
    await db.query('INSERT INTO variant_suppliers VALUES ($1, $2, 0, 1)', [
      variant,
      supplier,
    ]);
    await expect(
      db.query('INSERT INTO variant_suppliers VALUES ($1, $2, 42, 10)', [
        variant,
        supplier,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });
  for (const [price, date] of [
    ['-1', '1'],
    ['9007199254740992', '1'],
    ['0', '0'],
    ['0', '9007199254740992'],
  ])
    it(`rechaza fuera de rango ${price}/${date}`, async () => {
      await expect(
        db.query(
          'UPDATE variant_suppliers SET quoted_price_minor = $1, quoted_at_ms = $2 WHERE variant_id = $3',
          [price, date, variant],
        ),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
    });
  it('rechaza fracciones bigint y mantiene el rango máximo de ambos campos', async () => {
    await expect(
      db.query('UPDATE variant_suppliers SET quoted_price_minor = $1', ['1.5']),
    ).rejects.toMatchObject({ driverError: { code: '22P02' } });
    await db.query(
      'UPDATE variant_suppliers SET quoted_price_minor = $1, quoted_at_ms = $1',
      ['9007199254740991'],
    );
    expect(
      await db.query(
        'SELECT quoted_price_minor, quoted_at_ms FROM variant_suppliers',
      ),
    ).toEqual([
      {
        quoted_price_minor: '9007199254740991',
        quoted_at_ms: '9007199254740991',
      },
    ]);
  });
  it('FK rechazan huérfanos y RESTRICT impide borrar proveedor relacionado', async () => {
    await expect(
      db.query('INSERT INTO variant_suppliers VALUES ($1, $2, 0, 1)', [
        randomUUID(),
        supplier,
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      db.query('INSERT INTO variant_suppliers VALUES ($1, $2, 0, 1)', [
        variant,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
    await expect(
      db.query('DELETE FROM suppliers WHERE supplier_id = $1', [supplier]),
    ).rejects.toMatchObject({ driverError: { code: '23001' } });
  });
  it('down protege datos; CASCADE de variante solo elimina relaciones, nunca catálogo', async () => {
    await expect(db.undoLastMigration()).rejects.toThrow(
      'proveedores o precios',
    );
    await db.query('DELETE FROM product_variants WHERE variant_id = $1', [
      variant,
    ]);
    expect(await db.query('SELECT * FROM variant_suppliers')).toEqual([]);
    expect(await db.query('SELECT * FROM suppliers')).toHaveLength(2);
    await db.query('DELETE FROM suppliers');
    await db.undoLastMigration();
    expect(
      await db.query(
        'SELECT to_regclass($1) AS suppliers, to_regclass($2) AS relations',
        [`${schema}.suppliers`, `${schema}.variant_suppliers`],
      ),
    ).toEqual([{ suppliers: null, relations: null }]);
    expect(await db.query('SELECT name FROM products')).toEqual([
      { name: 'Previo' },
    ]);
  });
});
