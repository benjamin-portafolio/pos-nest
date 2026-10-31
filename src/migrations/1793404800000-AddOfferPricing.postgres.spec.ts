import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AddOfferPricing1793404800000 } from './1793404800000-AddOfferPricing';
const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('Oferta: migración PostgreSQL aislada', () => {
  const schema = `offer_migration_${process.pid}_${Date.now()}`;
  let admin: DataSource, db: DataSource;
  const migration = new AddOfferPricing1793404800000();
  const tables = [
    'products',
    'product_variants',
    'sales',
    'sale_items',
    'sale_payments',
    'events',
    'event_refs',
    'inventory_items',
    'inventory_balances',
    'inventory_movements',
    'clientes',
    'credit_sales',
    'customer_payments',
    'credit_allocations',
  ];
  const product = randomUUID(),
    variant = randomUUID(),
    event = randomUUID(),
    sale = randomUUID(),
    line = randomUUID(),
    unit = randomUUID(),
    item = randomUUID();
  const snapshot = async () =>
    Promise.all(tables.map((t) => db.query(`SELECT * FROM "${t}" ORDER BY 1`)));
  let before: any[][];
  beforeAll(async () => {
    if (
      process.env.DATABASE_HOST !== '127.0.0.1' ||
      !/^(pos_nest_test_|pos_cash_test_)/.test(process.env.DATABASE_NAME ?? '')
    )
      throw new Error('Solo PostgreSQL local de ensayo.');
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
      migrations: [AddOfferPricing1793404800000],
    }).initialize();
    await db.synchronize();
    await db.query(
      'ALTER TABLE product_variants DROP COLUMN offer_price_minor',
    );
    await db.query(
      'ALTER TABLE sales DROP COLUMN pricing_contract_version, DROP COLUMN pricing_mode',
    );
    await db.query("INSERT INTO products(product_id,name) VALUES ($1,'Café')", [
      product,
    ]);
    await db.query(
      'INSERT INTO product_variants(variant_id,product_id,sale_price_minor,standard_cost_minor,sort_order,created_event_id,last_event_id,last_server_sequence) VALUES ($1,$2,2500,0,0,$3,$3,42)',
      [variant, product, event],
    );
    await db.query(
      "INSERT INTO sales(sale_id,user_id,device_id,total_minor,currency,created_at_local) VALUES ($1,'u','d',5000,'MXN','2026-10-30T12:00:00Z')",
      [sale],
    );
    await db.query(
      'INSERT INTO sale_items(sale_item_id,sale_id,variant_id,total_minor,sort_order,snapshot) VALUES ($1,$2,$3,5000,0,$4)',
      [
        line,
        sale,
        variant,
        {
          snapshot: {
            quantity: 2,
            unit_price_minor: 2500,
            standard_cost_minor_snapshot: 123,
          },
        },
      ],
    );
    await db.query(
      "INSERT INTO sale_payments(payment_id,sale_id,method,amount_minor,received_minor,change_minor,currency) VALUES ($1,$2,'cash',5000,6000,1000,'MXN')",
      [randomUUID(), sale],
    );
    await db.query(
      "INSERT INTO events(event_id,aggregate_type,aggregate_id,event_type,device_id,user_id,created_at_local,payload) VALUES ($1,'product',$2,'producto_creado','d','u','2026-10-30T12:00:00Z',$3)",
      [event, product, { legacy: true, price: 2500 }],
    );
    await db.query(
      "INSERT INTO units(unit_id,code,name,symbol,dimension,atomic_factor,max_fraction_digits) VALUES ($1,'piece','Pieza','pza','count',1,0)",
      [unit],
    );
    await db.query(
      "INSERT INTO inventory_items(inventory_item_id,default_unit_id,name) VALUES ($1,$2,'Café')",
      [item, unit],
    );
    await db.query(
      'INSERT INTO inventory_balances(inventory_item_id,quantity_on_hand_atomic,quantity_available_atomic,last_event_id) VALUES ($1,17,16,$2)',
      [item, event],
    );
    await db.query(
      "INSERT INTO inventory_movements(movement_id,inventory_item_id,event_id,movement_type,quantity_delta_atomic,created_at_local) VALUES ($1,$2,$3,'initial_balance',17,'2026-10-30T12:00:00Z')",
      [randomUUID(), item, event],
    );
    await db.query(
      "INSERT INTO event_refs(event_ref_id,event_id,ref_type,ref_id,relationship,source,server_sequence) VALUES ($1,$2,'product',$3,'affects','server',42)",
      [randomUUID(), event, product],
    );
    const customer = randomUUID(), creditSale = randomUUID(), payment = randomUUID();
    await db.query("INSERT INTO clientes(cliente_id,nombre) VALUES ($1,'Cliente histórico')", [customer]);
    await db.query("INSERT INTO sales(sale_id,user_id,device_id,total_minor,currency,created_at_local,cliente_id) VALUES ($1,'u','d',7000,'MXN','2026-10-30T12:00:00Z',$2)", [creditSale, customer]);
    await db.query('INSERT INTO credit_sales(id,sale_id,cliente_id,amount_minor,occurred_at_ms) VALUES ($1,$1,$2,7000,100)', [creditSale, customer]);
    await db.query("INSERT INTO customer_payments(id,cliente_id,amount_minor,method,occurred_at_ms) VALUES ($1,$2,2000,'transfer',102)", [payment, customer]);
    await db.query('INSERT INTO credit_allocations(payment_id,credit_id,amount_minor) VALUES ($1,$2,2000)', [payment, creditSale]);
    before = await snapshot();
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('columna previa de tipo no acreditado se rechaza sin nuevas mutaciones', async () => {
    await db.query(
      'ALTER TABLE product_variants ADD COLUMN offer_price_minor integer',
    );
    const state = await snapshot();
    const q = db.createQueryRunner();
    try {
      await expect(migration.up(q)).rejects.toThrow(
        'Esquema previo incompatible',
      );
      expect(await snapshot()).toEqual(state);
    } finally {
      await q.release();
      await db.query(
        'ALTER TABLE product_variants DROP COLUMN offer_price_minor',
      );
    }
  });
  it('fallo transaccional revierte columnas y conserva todas las filas', async () => {
    const q = db.createQueryRunner();
    await q.startTransaction();
    await migration.up(q);
    await q.rollbackTransaction();
    await q.release();
    expect(await snapshot()).toEqual(before);
  });
  it('runMigrations, segunda ejecución e up repetido conservan valores anteriores y JSONB', async () => {
    expect(await db.runMigrations()).toHaveLength(1);
    expect(await db.runMigrations()).toHaveLength(0);
    const q = db.createQueryRunner();
    await migration.up(q);
    await q.release();
    const expected = structuredClone(before);
    expected[1] = expected[1].map((v) => ({ ...v, offer_price_minor: null }));
    expected[2] = expected[2].map((v) => ({
      ...v,
      pricing_contract_version: null,
      pricing_mode: null,
    }));
    expect(await snapshot()).toEqual(expected);
  });
  for (const value of [0, -1, 2501, '9007199254740992'])
    it(`rechaza oferta ${value} sin alterar datos`, async () => {
      const original = await snapshot();
      await expect(
        db.query('UPDATE product_variants SET offer_price_minor=$1', [value]),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await snapshot()).toEqual(original);
    });
  it('oferta válida y N1 al bajar normal; downgrade está protegido', async () => {
    await db.query('UPDATE product_variants SET offer_price_minor=2000');
    await expect(
      db.query('UPDATE product_variants SET sale_price_minor=1999'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(db.undoLastMigration()).rejects.toThrow('downgrade');
    expect(
      (await db.query('SELECT offer_price_minor FROM product_variants'))[0]
        .offer_price_minor,
    ).toBe('2000');
  });
});
