import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AddVariantMinimumStock1792368000000 } from './1792368000000-AddVariantMinimumStock';

const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('Mínimos: migración y entidad en PostgreSQL aislado real', () => {
  const schema = `minimum_stock_${process.pid}_${Date.now()}`;
  let admin: DataSource, db: DataSource;
  const product = randomUUID(),
    variant = randomUUID(),
    item = randomUUID(),
    unit = randomUUID(),
    event = randomUUID();
  let previous: unknown[][];
  let entityColumn: unknown[];
  const tables = [
    'products',
    'product_variants',
    'inventory_items',
    'inventory_balances',
    'inventory_movements',
    'events',
  ];
  const snapshot = async () =>
    Promise.all(tables.map((t) => db.query(`SELECT * FROM "${t}"`))) as Promise<
      unknown[][]
    >;
  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    };
    admin = await new DataSource(connection).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = await new DataSource({
      ...connection,
      schema,
      extra: { options: `-c search_path=${schema},public` },
      entities: [__dirname + '/../entities/*.entity.ts'],
      migrations: [AddVariantMinimumStock1792368000000],
    }).initialize();
    // Esquema real de las entidades; luego se retira únicamente la adición para
    // reproducir el esquema inmediatamente anterior con filas de negocio.
    await db.synchronize();
    await db.query(
      'INSERT INTO units (unit_id, code, name, symbol, dimension, atomic_factor, max_fraction_digits) VALUES ($1, $2, $2, $2, $3, 1, 0)',
      [unit, 'piece', 'count'],
    );
    await db.query(
      'INSERT INTO inventory_items (inventory_item_id, default_unit_id, name) VALUES ($1, $2, $3)',
      [item, unit, 'Café'],
    );
    await db.query(
      'INSERT INTO products (product_id, name, created_event_id, last_event_id) VALUES ($1, $2, $3, $3)',
      [product, 'Previo', event],
    );
    await db.query(
      'INSERT INTO product_variants (variant_id, product_id, sale_price_minor, sort_order, inventory_item_id, created_event_id, last_event_id) VALUES ($1, $2, 2500, 0, $3, $4, $4)',
      [variant, product, item, event],
    );
    await db.query(
      'INSERT INTO inventory_balances (inventory_item_id, quantity_on_hand_atomic, quantity_available_atomic, last_event_id) VALUES ($1, 17, 17, $2)',
      [item, event],
    );
    await db.query(
      "INSERT INTO inventory_movements (movement_id, inventory_item_id, event_id, movement_type, quantity_delta_atomic, created_at_local) VALUES ($1, $2, $3, 'initial_balance', 17, '2026-10-19T12:00:00Z')",
      [randomUUID(), item, event],
    );
    await db.query(
      "INSERT INTO events (event_id, aggregate_type, aggregate_id, event_type, device_id, user_id, created_at_local, payload) VALUES ($1, 'product', $2, 'producto_creado', 'test-device', 'test-user', '2026-10-19T12:00:00Z', $3)",
      [event, product, { variants: [{ variant_id: variant }] }],
    );
    entityColumn = await db.query(
      "SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='product_variants' AND column_name='minimum_stock_atomic'",
      [schema],
    );
    await expect(
      db.query('UPDATE product_variants SET minimum_stock_atomic = -1'),
    ).rejects.toMatchObject({ code: '23514' });
    await db.query(
      'ALTER TABLE product_variants DROP COLUMN minimum_stock_atomic',
    );
    previous = await snapshot();
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('entidad declara bigint nullable sin default y CHECK activo', () => {
    expect(entityColumn).toEqual([
      { data_type: 'bigint', is_nullable: 'YES', column_default: null },
    ]);
  });
  it('runMigrations e up repetido agregan null sin tocar IDs, eventos, saldos ni movimientos', async () => {
    expect(await db.runMigrations()).toHaveLength(1);
    expect(await db.runMigrations()).toHaveLength(0);
    const runner = db.createQueryRunner();
    try {
      await new AddVariantMinimumStock1792368000000().up(runner);
    } finally {
      await runner.release();
    }
    const expected = structuredClone(previous);
    expected[1] = (expected[1] as Record<string, unknown>[]).map((v) => ({
      ...v,
      minimum_stock_atomic: null,
    }));
    expect(await snapshot()).toEqual(expected);
  });
  for (const value of [null, '0', '1500', '9007199254740991']) {
    it(`SQL admite ${value} y lee bigint exacto`, async () => {
      await db.query('UPDATE product_variants SET minimum_stock_atomic = $1', [
        value,
      ]);
      expect(
        await db.query('SELECT minimum_stock_atomic FROM product_variants'),
      ).toEqual([{ minimum_stock_atomic: value }]);
    });
  }
  for (const [value, code] of [
    ['-1', '23514'],
    ['9007199254740992', '23514'],
    ['1.5', '22P02'],
    ['texto', '22P02'],
  ]) {
    it(`SQL rechaza ${value} sin alterar valor previo`, async () => {
      const before = await snapshot();
      await expect(
        db.query('UPDATE product_variants SET minimum_stock_atomic = $1', [
          value,
        ]),
      ).rejects.toMatchObject({ code });
      expect(await snapshot()).toEqual(before);
    });
  }
  it('down protege mínimos (incluido cero) y revierte la adición cuando son null', async () => {
    await db.query('UPDATE product_variants SET minimum_stock_atomic = 0');
    await expect(db.undoLastMigration()).rejects.toThrow(
      'mínimos configurados',
    );
    expect(
      await db.query('SELECT minimum_stock_atomic FROM product_variants'),
    ).toEqual([{ minimum_stock_atomic: '0' }]);
    await db.query('UPDATE product_variants SET minimum_stock_atomic = NULL');
    await db.undoLastMigration();
    expect(await snapshot()).toEqual(previous);
    expect(
      await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='product_variants' AND column_name='minimum_stock_atomic'",
        [schema],
      ),
    ).toEqual([]);
  });
});
