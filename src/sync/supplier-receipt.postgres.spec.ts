import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SupplierOrderEventHandler } from './supplier-order-event.handler';
import { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';
import { PushEventDto } from './dto/push-events.dto';
import { validateRecoverySupplierOrders } from '../recovery/recovery-supplier-order-validation';
const integration =
  process.env.RUN_SUPPLIER_RECEIPTS_PG === '1' ? describe : describe.skip;
integration('S4 PostgreSQL real aislado: recepción atómica', () => {
  let admin: DataSource, db: DataSource, service: SyncService;
  const schema = `supplier_s4_${process.pid}_${Date.now()}`;
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
      process.env.DATABASE_PORT !== '55494' ||
      process.env.DATABASE_NAME !== 'pos_nest_test_supplier_s4'
    )
      throw new Error('Solo ensayo aislado S4');
    const options = {
      type: 'postgres' as const,
      host: '127.0.0.1',
      port: 55494,
      username: 'supplier_s4',
      database: 'pos_nest_test_supplier_s4',
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
  async function confirmed() {
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
    return { d, c, cr };
  }
  function receive(
    d: PushEventDto,
    base: PushEventDto,
    version: number,
    seq: number | null,
    qty = 3,
    overage = false,
  ) {
    return event(
      'supplier_receipt_confirmed',
      d.aggregate_id,
      {
        contract_version: 1,
        order_id: d.aggregate_id,
        base_event_id: base.event_id,
        receipt_id: randomUUID(),
        occurred_at_ms: 200,
        total_minor: qty * 120,
        items: [
          {
            order_item_id: (d.payload.items as any[])[0].id,
            movement_id: randomUUID(),
            quantity_atomic: qty,
            actual_price_minor: 120,
            reference_quantity_atomic: 1,
            total_minor: qty * 120,
            overage_acknowledged: overage,
          },
        ],
      },
      version,
      seq,
    );
  }
  test('Parcial + remanente, idempotencia estricta, precio documental e historial recuperable', async () => {
    const { d, c, cr } = await confirmed();
    const r = receive(d, c, 2, cr.server_sequence!);
    const rr = await push(r);
    expect(rr.status).toBe('accepted');
    expect((await push(r)).status).toBe('duplicate');
    expect(
      (await push({ ...r, payload: { ...r.payload, occurred_at_ms: 201 } }))
        .status,
    ).toBe('rejected');
    const before = await db.query(
      'SELECT * FROM inventory_balances WHERE inventory_item_id=$1',
      [item],
    );
    const reused = receive(d, r, 3, rr.server_sequence!, 1);
    reused.payload.receipt_id = r.payload.receipt_id;
    expect((await push(reused)).status).toBe('conflict');
    expect(
      await db.query(
        'SELECT * FROM inventory_balances WHERE inventory_item_id=$1',
        [item],
      ),
    ).toEqual(before);
    const last = receive(d, r, 3, rr.server_sequence!, 1);
    expect((await push(last)).status).toBe('accepted');
    const [order] = await db.query(
      'SELECT * FROM supplier_orders WHERE id=$1',
      [d.aggregate_id],
    );
    expect(order.status).toBe('received');
    expect(order.total_minor).toBe('14004');
    const [line] = await db.query(
      'SELECT * FROM supplier_order_items WHERE order_id=$1',
      [d.aggregate_id],
    );
    expect(line.quoted_price_minor).toBe('3501');
    expect(line.quantity_atomic).toBe('4');
    await validateRecoverySupplierOrders(db.manager);
    await db.query('UPDATE supplier_receipts SET total_minor=1 WHERE id=$1', [
      r.payload.receipt_id,
    ]);
    await expect(validateRecoverySupplierOrders(db.manager)).rejects.toThrow();
    await db.query('UPDATE supplier_receipts SET total_minor=$1 WHERE id=$2', [
      r.payload.total_minor,
      r.payload.receipt_id,
    ]);
  });
  test('Dos terminales sobre una base: una sola entrada; cierre exacto sin movimientos', async () => {
    const { d, c, cr } = await confirmed();
    const a = receive(d, c, 2, cr.server_sequence!),
      b = receive(d, c, 2, cr.server_sequence!);
    const result = await Promise.all([push(a), push(b)]);
    expect(result.map((r) => r.status).sort()).toEqual([
      'accepted',
      'conflict',
    ]);
    const win = result[0].status === 'accepted' ? a : b,
      wr = result.find((r) => r.status === 'accepted')!;
    const before = await stock();
    const close = event(
      'supplier_order_closed',
      d.aggregate_id,
      {
        contract_version: 1,
        order_id: d.aggregate_id,
        base_event_id: win.event_id,
        occurred_at_ms: 300,
        items: [
          {
            order_item_id: (d.payload.items as any[])[0].id,
            closed_quantity_atomic: 1,
          },
        ],
      },
      3,
      wr.server_sequence!,
    );
    expect((await push(close)).status).toBe('accepted');
    expect((await push(close)).status).toBe('duplicate');
    expect(await stock()).toEqual(before);
    expect((await push(receive(d, close, 4, null, 1))).status).toBe('conflict');
    expect(
      (
        await db.query(
          'SELECT closed_quantity_atomic FROM supplier_order_items WHERE order_id=$1',
          [d.aggregate_id],
        )
      )[0].closed_quantity_atomic,
    ).toBe('1');
    await validateRecoverySupplierOrders(db.manager);
  });
  test('Recurso/unidad/actividad/exceso/cero inválidos sin efectos; rollback de fallo después del movimiento', async () => {
    const { d, c, cr } = await confirmed();
    const before = await stock();
    const excess = receive(d, c, 2, cr.server_sequence!, 5);
    expect((await push(excess)).status).toBe('conflict');
    expect((await push(receive(d, c, 2, cr.server_sequence!, 0))).status).toBe(
      'rejected',
    );
    for (const sql of [
      'UPDATE inventory_items SET active=false WHERE inventory_item_id=$1',
      'UPDATE product_variants SET inventory_item_id=NULL WHERE inventory_item_id=$1',
    ]) {
      await db.query(sql, [item]);
      expect((await push(receive(d, c, 2, cr.server_sequence!))).status).toBe(
        'conflict',
      );
      await db.query(
        'UPDATE inventory_items SET active=true WHERE inventory_item_id=$1',
        [item],
      );
      await db.query(
        'UPDATE product_variants SET inventory_item_id=$1 WHERE variant_id=$2',
        [item, variant],
      );
    }
    await db.query('UPDATE units SET atomic_factor=2 WHERE unit_id=$1', [unit]);
    expect((await push(receive(d, c, 2, cr.server_sequence!))).status).toBe(
      'conflict',
    );
    await db.query('UPDATE units SET atomic_factor=1 WHERE unit_id=$1', [unit]);
    expect(await stock()).toEqual(before);
    await db.query(
      `CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced receipt storage failure'; END $$`,
    );
    await db.query(
      'CREATE TRIGGER fail_receipt BEFORE INSERT ON supplier_receipt_items FOR EACH ROW EXECUTE FUNCTION fail_receipt()',
    );
    const r = receive(d, c, 2, cr.server_sequence!, 5, true);
    await expect(push(r)).rejects.toThrow('forced receipt storage failure');
    expect(await stock()).toEqual(before);
    expect(
      await db.query('SELECT * FROM supplier_receipts WHERE order_id=$1', [
        d.aggregate_id,
      ]),
    ).toHaveLength(0);
    expect(
      await db.query('SELECT * FROM events WHERE event_id=$1', [r.event_id]),
    ).toHaveLength(0);
    await db.query('DROP TRIGGER fail_receipt ON supplier_receipt_items');
    expect((await push(r)).status).toBe('accepted');
    await validateRecoverySupplierOrders(db.manager);
  });
  test('50 partidas: fallo en segunda partida revierte primera y todo el documento', async () => {
    const d = draft(),
      template = (d.payload.items as any[])[0];
    const variants = [variant],
      resources = [item];
    for (let i = 1; i < 50; i++) {
      const id = randomUUID(),
        resource = randomUUID();
      variants.push(id);
      resources.push(resource);
      await db.query(
        "INSERT INTO inventory_items(inventory_item_id,default_unit_id,name) VALUES($1,$2,'Recurso')",
        [resource, unit],
      );
      await db.query(
        'INSERT INTO inventory_balances(inventory_item_id,quantity_on_hand_atomic,quantity_available_atomic,last_event_id) VALUES($1,0,0,$2)',
        [resource, randomUUID()],
      );
      await db.query(
        'INSERT INTO product_variants(variant_id,product_id,name,name_key,sale_price_minor,sort_order,inventory_item_id) VALUES($1,$2,$3::text,lower($3::text),1000,$4,$5)',
        [id, product, 'Variante ' + i, i, resource],
      );
      await db.query('INSERT INTO variant_suppliers VALUES($1,$2,3501,100)', [
        id,
        supplier,
      ]);
    }
    const lines = variants.map((v, i) => ({
      ...template,
      id: randomUUID(),
      variant_id: v,
      inventory_item_id: resources[i],
      variant_name_snapshot: i ? 'Variante ' + i : null,
    }));
    d.payload.items = lines;
    d.payload.total_minor = 14004 * 50;
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
    const before = await stock();
    const r = receive(d, c, 2, cr.server_sequence!);
    r.payload.items = lines.map((l) => ({
      order_item_id: l.id,
      movement_id: randomUUID(),
      quantity_atomic: 1,
      actual_price_minor: 120,
      reference_quantity_atomic: 1,
      total_minor: 120,
      overage_acknowledged: false,
    }));
    r.payload.total_minor = 6000;
    await db.query(`CREATE OR REPLACE FUNCTION fail_second_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.order_item_id='${lines[1].id}'::uuid THEN RAISE EXCEPTION 'forced second line'; END IF; RETURN NEW; END $$`);
    await db.query(
      'CREATE TRIGGER fail_second_receipt BEFORE INSERT ON supplier_receipt_items FOR EACH ROW EXECUTE FUNCTION fail_second_receipt()',
    );
    await expect(push(r)).rejects.toThrow('forced second line');
    expect(await stock()).toEqual(before);
    await db.query(
      'DROP TRIGGER fail_second_receipt ON supplier_receipt_items',
    );
    const [prior] = await db.query(
      'SELECT version FROM inventory_balances WHERE inventory_item_id=$1',
      [item],
    );
    expect((await push(r)).status).toBe('accepted');
    const [after] = await db.query(
      'SELECT version FROM inventory_balances WHERE inventory_item_id=$1',
      [item],
    );
    expect(after.version).toBe(prior.version + 1);
    expect(
      (
        await db.query(
          'SELECT * FROM supplier_receipt_items WHERE receipt_id=$1',
          [r.payload.receipt_id],
        )
      ).length,
    ).toBe(50);
    await validateRecoverySupplierOrders(db.manager);
  });
});
