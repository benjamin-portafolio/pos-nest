import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SupplierOrderEventHandler } from './supplier-order-event.handler';
import { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';
import { PushEventDto } from './dto/push-events.dto';
import { validateRecoverySupplierOrders } from '../recovery/recovery-supplier-order-validation';
const integration =
  process.env.RUN_SUPPLIER_ORDERS_PG === '1' ? describe : describe.skip;
integration('S3 PostgreSQL real aislado: pedidos sin inventario', () => {
  let admin: DataSource, db: DataSource, service: SyncService;
  const schema = `supplier_s3_${process.pid}_${Date.now()}`;
  const supplier = randomUUID(),
    variant = randomUUID(),
    product = randomUUID(),
    item = randomUUID(),
    unit = randomUUID();
  let local = 0;
  function event(
    type: string,
    id: string,
    payload: any,
    version = 1,
    sequence: number | null = null,
  ): PushEventDto {
    return {
      event_id: randomUUID(),
      aggregate_type: 'supplier_order',
      aggregate_id: id,
      event_type: type,
      device_id: 'orders-pg',
      user_id: 'synthetic',
      local_sequence: ++local,
      base_version: version,
      base_server_sequence: sequence,
      created_at_local: '2026-11-19T12:00:00.000Z',
      payload,
    };
  }
  const push = async (e: PushEventDto) =>
    (await service.pushEvents({ device_id: e.device_id, events: [e] }))
      .results[0];
  function draft() {
    const id = randomUUID();
    const payload = {
      contract_version: 1,
      order_id: id,
      base_event_id: null,
      supplier_id: supplier,
      supplier_name_snapshot: 'Proveedor original',
      supplier_phone_snapshot: null,
      currency: 'MXN',
      occurred_at_ms: 100,
      notes: null,
      total_minor: 14004,
      items: [
        {
          id: randomUUID(),
          variant_id: variant,
          inventory_item_id: item,
          unit_id: unit,
          product_name_snapshot: 'Café original',
          variant_name_snapshot: null,
          dimension: 'count',
          unit_code_snapshot: 'piece',
          unit_symbol_snapshot: 'pza',
          unit_atomic_factor: 1,
          reference_quantity_atomic: 1,
          quantity_atomic: 4,
          quoted_price_minor: 3501,
          total_minor: 14004,
        },
      ],
    };
    return event('supplier_order_draft_saved', id, payload);
  }
  beforeAll(async () => {
    if (
      process.env.DATABASE_HOST !== '127.0.0.1' ||
      process.env.DATABASE_PORT !== '55493' ||
      process.env.DATABASE_NAME !== 'pos_nest_test_supplier_s3'
    )
      throw new Error('Solo ensayo aislado S3');
    const options = {
      type: 'postgres' as const,
      host: '127.0.0.1',
      port: 55493,
      username: 'supplier_s3',
      database: 'pos_nest_test_supplier_s3',
    };
    admin = await new DataSource(options).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = await new DataSource({
      ...options,
      schema,
      uuidExtension: 'pgcrypto',
      extra: { options: `-c search_path=${schema},public` },
      entities: [__dirname + '/../entities/*.entity.ts'],
      synchronize: true,
    }).initialize();
    const c = new SyncConflictService();
    service = new SyncService(
      db,
      { notifyEventsAvailable: async () => {} } as any,
      c,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new SupplierOrderEventHandler(c),
    );
    await db.query(
      "INSERT INTO suppliers(supplier_id,name) VALUES($1,'Proveedor original')",
      [supplier],
    );
    await db.query(
      "INSERT INTO units(unit_id,code,name,symbol,dimension,atomic_factor,max_fraction_digits) VALUES($1,'piece','Pieza','pza','count',1,0)",
      [unit],
    );
    await db.query(
      "INSERT INTO inventory_items(inventory_item_id,default_unit_id,name) VALUES($1,$2,'Recurso')",
      [item, unit],
    );
    await db.query(
      "INSERT INTO products(product_id,name) VALUES($1,'Café original')",
      [product],
    );
    await db.query(
      'INSERT INTO product_variants(variant_id,product_id,sale_price_minor,sort_order,inventory_item_id) VALUES($1,$2,1000,0,$3)',
      [variant, product, item],
    );
    await db.query('INSERT INTO variant_suppliers VALUES($1,$2,3501,100)', [
      variant,
      supplier,
    ]);
    await db.query(
      'INSERT INTO inventory_balances(inventory_item_id,quantity_on_hand_atomic,quantity_available_atomic,last_event_id) VALUES($1,3,3,$2)',
      [item, randomUUID()],
    );
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  const stock = async () => [
    await db.query(
      'SELECT * FROM inventory_balances ORDER BY inventory_item_id',
    ),
    await db.query('SELECT * FROM inventory_movements ORDER BY movement_id'),
  ];
  test('Persistencia, snapshots, duplicado estricto, consultar/cancelar sin tocar balances o movimientos', async () => {
    const before = await stock();
    const d = draft();
    const dr = await push(d);
    expect(dr.status).toBe('accepted');
    const c = event(
      'supplier_order_confirmed',
      d.aggregate_id,
      { ...d.payload, base_event_id: d.event_id },
      1,
      dr.server_sequence!,
    );
    const cr = await push(c);
    expect(cr.status).toBe('accepted');
    expect((await push(c)).status).toBe('duplicate');
    expect(
      (await push({ ...c, payload: { ...c.payload, notes: 'Otra intención' } }))
        .status,
    ).toBe('rejected');
    await db.query(
      "UPDATE suppliers SET name='Proveedor renombrado' WHERE supplier_id=$1",
      [supplier],
    );
    await db.query(
      'UPDATE variant_suppliers SET quoted_price_minor=99 WHERE variant_id=$1',
      [variant],
    );
    await db.query("UPDATE products SET name='Café renombrado' WHERE product_id=$1",[product]);
    const [line]=await db.query('SELECT * FROM supplier_order_items WHERE order_id=$1',[d.aggregate_id]);
    expect(line.product_name_snapshot).toBe('Café original');
    expect(line.quoted_price_minor).toBe('3501');
    const [row] = await db.query('SELECT * FROM supplier_orders WHERE id=$1', [
      d.aggregate_id,
    ]);
    expect(row.supplier_name_snapshot).toBe('Proveedor original');
    expect(row.total_minor).toBe('14004');
    const ca = event(
      'supplier_order_cancelled',
      d.aggregate_id,
      {
        contract_version: 1,
        order_id: d.aggregate_id,
        base_event_id: c.event_id,
        occurred_at_ms: 101,
      },
      2,
      cr.server_sequence!,
    );
    expect((await push(ca)).status).toBe('accepted');
    expect((await push(ca)).status).toBe('duplicate');
    expect(await stock()).toEqual(before);
    await validateRecoverySupplierOrders(db.manager);
  });
  test('Dos confirmaciones simultáneas y cancelación obsoleta: una gana, conflicto visible y sin stock', async () => {
    const before = await stock();
    const d = draft();
    const dr = await push(d);
    const c1 = event(
      'supplier_order_confirmed',
      d.aggregate_id,
      { ...d.payload, base_event_id: d.event_id },
      1,
      dr.server_sequence!,
    );
    const c2 = event(
      'supplier_order_confirmed',
      d.aggregate_id,
      { ...d.payload, base_event_id: d.event_id },
      1,
      dr.server_sequence!,
    );
    const results = await Promise.all([push(c1), push(c2)]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'accepted',
      'conflict',
    ]);
    const stale = event(
      'supplier_order_cancelled',
      d.aggregate_id,
      {
        contract_version: 1,
        order_id: d.aggregate_id,
        base_event_id: d.event_id,
        occurred_at_ms: 102,
      },
      1,
      dr.server_sequence!,
    );
    expect((await push(stale)).status).toBe('conflict');
    expect(await stock()).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT * FROM sync_conflicts WHERE ref_type='supplier_order'",
        )
      ).length,
    ).toBeGreaterThan(0);
  });
  test('Partida no elegible revierte documento; recuperación rechaza snapshots adulterados', async () => {
    const d = draft();
    d.payload.items = (d.payload.items as any[]).map((l) => ({
      ...l,
      inventory_item_id: randomUUID(),
    }));
    expect((await push(d)).status).toBe('conflict');
    expect(
      await db.query('SELECT * FROM supplier_orders WHERE id=$1', [
        d.aggregate_id,
      ]),
    ).toHaveLength(0);
    const good = draft();
    await push(good);
    await db.query(
      "UPDATE supplier_orders SET supplier_name_snapshot='Adulterado' WHERE id=$1",
      [good.aggregate_id],
    );
    await expect(validateRecoverySupplierOrders(db.manager)).rejects.toThrow();
  });
});
