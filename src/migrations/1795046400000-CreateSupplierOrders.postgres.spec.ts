import { writeFileSync } from 'fs';
import { ProductoEventHandler } from '../sync/producto-event.handler';
import { ProveedorEventHandler } from '../sync/proveedor-event.handler';
import { SyncConflictService } from '../sync/sync-conflict.service';
import { ProductEntity } from '../entities/product.entity';
import { EventEntity } from '../entities/event.entity';
import { PushEventDto } from '../sync/dto/push-events.dto';
import { supplierFixture } from '../testing/supplier-contract-fixtures';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CreateSupplierOrders1795046400000 } from './1795046400000-CreateSupplierOrders';
import { CreateRecoveryProtocol1794096000000 } from './1794096000000-CreateRecoveryProtocol';
import {
  BUSINESS_TABLES,
  SCHEMA_FINGERPRINT_SQL,
} from '../recovery/recovery-schema';

const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('Pedidos S1: migración PostgreSQL real aislada', () => {
  const schema = `supplier_s1_${process.pid}_${Date.now()}`;
  const tables = [
    'products',
    'product_variants',
    'suppliers',
    'variant_suppliers',
    'sales',
    'sale_items',
    'events',
    'event_refs',
    'inventory_items',
    'inventory_balances',
    'inventory_movements',
  ];
  let admin: DataSource, db: DataSource;
  const product = randomUUID(),
    variant = randomUUID(),
    supplier = randomUUID(),
    other = randomUUID();
  const event = randomUUID(),
    unit = randomUUID(),
    item = randomUUID(),
    sale = randomUUID();
  let before: any[];
  const snapshot = async () =>
    Promise.all(tables.map((t) => db.query(`SELECT * FROM "${t}" ORDER BY 1`)));
  beforeAll(async () => {
    if (
      process.env.DATABASE_HOST !== '127.0.0.1' ||
      process.env.DATABASE_PORT !== '55491' ||
      process.env.DATABASE_NAME !== 'pos_nest_test_supplier_s1'
    )
      throw new Error('Solo clúster temporal S1');
    const connection = {
      type: 'postgres' as const,
      host: '127.0.0.1',
      port: 55491,
      username: 'supplier_s1',
      database: 'pos_nest_test_supplier_s1',
    };
    admin = await new DataSource(connection).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = await new DataSource({
      ...connection,
      schema,
      extra: { options: `-c search_path=${schema},public` },
      entities: [__dirname + '/../entities/*.entity.ts'],
      migrations: [CreateSupplierOrders1795046400000],
    }).initialize();
    // Entity metadata creates an isolated pre-migration fixture, then remove only S1 additions.
    await db.synchronize();
    await db.query(
      'DROP TABLE supplier_receipt_items,supplier_receipts,supplier_order_items,supplier_orders',
    );
    await db.query(
      'ALTER TABLE product_variants DROP COLUMN current_supplier_id, DROP COLUMN target_stock_atomic',
    );
    await db.query("INSERT INTO products(product_id,name) VALUES($1,'Café')", [
      product,
    ]);
    await db.query(
      'INSERT INTO product_variants(variant_id,product_id,sale_price_minor,sort_order,minimum_stock_atomic,created_event_id,last_event_id,last_server_sequence) VALUES($1,$2,3501,0,3,$3,$3,42)',
      [variant, product, event],
    );
    await db.query(
      "INSERT INTO suppliers(supplier_id,name) VALUES($1,'Proveedor'),($2,'Alternativo')",
      [supplier, other],
    );
    await db.query('INSERT INTO variant_suppliers VALUES($1,$2,3501,100)', [
      variant,
      supplier,
    ]);
    await db.query(
      "INSERT INTO units(unit_id,code,name,symbol,dimension,atomic_factor,max_fraction_digits) VALUES($1,'piece','Pieza','pza','count',1,0)",
      [unit],
    );
    await db.query(
      "INSERT INTO inventory_items(inventory_item_id,default_unit_id,name) VALUES($1,$2,'Café físico')",
      [item, unit],
    );
    await db.query(
      'INSERT INTO inventory_balances(inventory_item_id,quantity_on_hand_atomic,quantity_available_atomic,last_event_id) VALUES($1,17,16,$2)',
      [item, event],
    );
    await db.query(
      "INSERT INTO inventory_movements(movement_id,inventory_item_id,event_id,movement_type,quantity_delta_atomic,created_at_local) VALUES($1,$2,$3,'initial_balance',17,now())",
      [randomUUID(), item, event],
    );
    await db.query(
      "INSERT INTO sales(sale_id,user_id,device_id,total_minor,currency,created_at_local) VALUES($1,'u','d',3501,'MXN',now())",
      [sale],
    );
    await db.query(
      'INSERT INTO sale_items(sale_item_id,sale_id,variant_id,total_minor,sort_order,snapshot) VALUES($1,$2,$3,3501,0,$4)',
      [randomUUID(), sale, variant, { legacy: true }],
    );
    await db.query(
      "INSERT INTO events(event_id,aggregate_type,aggregate_id,event_type,device_id,user_id,created_at_local,payload) VALUES($1,'product',$2,'producto_creado','d','u',now(),$3)",
      [event, product, { legacy: true }],
    );
    await db.query(
      "INSERT INTO event_refs(event_ref_id,event_id,ref_type,ref_id,relationship,source) VALUES($1,$2,'product',$3,'affects','server')",
      [randomUUID(), event, product],
    );
    // Install the actual historic recovery migration; new migration must extend its gate and fingerprint.
    const q = db.createQueryRunner();
    await q.startTransaction();
    try {
      await new CreateRecoveryProtocol1794096000000().up(q);
      await q.commitTransaction();
    } catch (e) {
      await q.rollbackTransaction();
      throw e;
    } finally {
      await q.release();
    }
    before = await snapshot();
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  it('fallo revierte DDL y todas las filas', async () => {
    const q = db.createQueryRunner();
    await q.startTransaction();
    await new CreateSupplierOrders1795046400000().up(q);
    await q.rollbackTransaction();
    await q.release();
    expect(await snapshot()).toEqual(before);
    expect(
      (await db.query("SELECT to_regclass('supplier_orders') AS t"))[0].t,
    ).toBeNull();
  });
  it('esquema previo desconocido falla sin alterar datos', async () => {
    await db.query(
      'ALTER TABLE product_variants ADD COLUMN current_supplier_id text',
    );
    const q = db.createQueryRunner();
    await q.startTransaction();
    await expect(
      new CreateSupplierOrders1795046400000().up(q),
    ).rejects.toThrow();
    await q.rollbackTransaction();
    await q.release();
    await db.query(
      'ALTER TABLE product_variants DROP COLUMN current_supplier_id',
    );
    expect(await snapshot()).toEqual(before);
  });
  it('recuperación activa rechaza migración antes de mutar estructura', async () => {
    await db.query("UPDATE server_state SET mode='recovering'");
    await expect(db.runMigrations()).rejects.toThrow('Recuperación activa');
    expect(
      (await db.query("SELECT to_regclass('supplier_orders') AS t"))[0].t,
    ).toBeNull();
    expect(await snapshot()).toEqual(before);
    await db.query("UPDATE server_state SET mode='active'");
  });
  it('runMigrations conserva negocio; segunda ejecución no repite', async () => {
    expect(await db.runMigrations()).toHaveLength(1);
    expect(await db.runMigrations()).toHaveLength(0);
    const metadata = await db.query(`SELECT t.table_name,
      (SELECT json_agg(c ORDER BY c.ordinal_position) FROM information_schema.columns c WHERE c.table_schema=current_schema() AND c.table_name=t.table_name) AS columns,
      (SELECT json_agg(json_build_object('name',x.conname,'definition',pg_get_constraintdef(x.oid))) FROM pg_constraint x WHERE x.conrelid=(quote_ident(current_schema())||'.'||quote_ident(t.table_name))::regclass) AS constraints,
      (SELECT json_agg(i.indexdef ORDER BY i.indexname) FROM pg_indexes i WHERE i.schemaname=current_schema() AND i.tablename=t.table_name) AS indexes,
      (SELECT json_agg(pg_get_triggerdef(tr.oid)) FROM pg_trigger tr WHERE tr.tgrelid=(quote_ident(current_schema())||'.'||quote_ident(t.table_name))::regclass AND NOT tr.tgisinternal) AS triggers
      FROM information_schema.tables t WHERE t.table_schema=current_schema() AND t.table_name IN ('supplier_orders','supplier_order_items','supplier_receipts','supplier_receipt_items','product_variants') ORDER BY t.table_name`);
    writeFileSync(
      '/tmp/supplier-s1-pg-metadata.json',
      JSON.stringify(
        {
          source: 'PostgreSQL 18: ensayo aislado, no operativo',
          tables: metadata,
        },
        null,
        2,
      ) + '\n',
    );
    const after = await snapshot();
    const expected = structuredClone(before);
    expected[1] = expected[1].map((v) => ({
      ...v,
      current_supplier_id: null,
      target_stock_atomic: null,
    }));
    expect(after).toEqual(expected);
    const [fp] = await db.query(SCHEMA_FINGERPRINT_SQL, [BUSINESS_TABLES]);
    expect(
      (await db.query('SELECT schema_fingerprint FROM server_state'))[0]
        .schema_fingerprint,
    ).toBe(fp.fingerprint);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='recovery_business_gate' AND tgrelid IN ('supplier_orders'::regclass,'supplier_order_items'::regclass,'supplier_receipts'::regclass,'supplier_receipt_items'::regclass)",
        )
      )[0].n,
    ).toBe(4);
  });
  it('crear variante -> relaciones -> seleccionar; retirar pareja seleccionada falla', async () => {
    await expect(
      db.query(
        'UPDATE product_variants SET current_supplier_id=$1 WHERE variant_id=$2',
        [other, variant],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await db.transaction(async (m) => {
      await m.query('INSERT INTO variant_suppliers VALUES($1,$2,0,100)', [
        variant,
        other,
      ]);
      await m.query(
        'UPDATE product_variants SET current_supplier_id=$1,target_stock_atomic=0 WHERE variant_id=$2',
        [other, variant],
      );
    });
    await expect(
      db.query(
        'DELETE FROM variant_suppliers WHERE variant_id=$1 AND supplier_id=$2',
        [variant, other],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      db.query(
        'UPDATE variant_suppliers SET supplier_id=$1 WHERE variant_id=$2 AND supplier_id=$3',
        [randomUUID(), variant, other],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('reemplazo ordenado conserva selección; fallo revierte relación y selección', async () => {
    const replace = async (fail: boolean) =>
      db.transaction(async (m) => {
        await m.query(
          'UPDATE product_variants SET current_supplier_id=NULL WHERE variant_id=$1',
          [variant],
        );
        await m.query('DELETE FROM variant_suppliers WHERE variant_id=$1', [
          variant,
        ]);
        await m.query('INSERT INTO variant_suppliers VALUES($1,$2,0,100)', [
          variant,
          other,
        ]);
        if (fail) throw new Error('fallo inducido');
        await m.query(
          'UPDATE product_variants SET current_supplier_id=$1 WHERE variant_id=$2',
          [other, variant],
        );
      });
    const state = await snapshot();
    await expect(replace(true)).rejects.toThrow('fallo inducido');
    expect(await snapshot()).toEqual(state);
    await replace(false);
    expect(
      (await db.query('SELECT current_supplier_id FROM product_variants'))[0]
        .current_supplier_id,
    ).toBe(other);
  });
  it('FK compuesta protege selección contra DELETE concurrente aun sin lecturas previas', async () => {
    const q = db.createQueryRunner();
    await q.startTransaction();
    // DML concurrente bloquea en FK o trigger; lock_timeout verifica espera real.
    await q.query(
      'SELECT 1 FROM variant_suppliers WHERE variant_id=$1 AND supplier_id=$2 FOR UPDATE',
      [variant, other],
    );
    const second = db.createQueryRunner();
    await second.startTransaction();
    await second.query("SET LOCAL lock_timeout='150ms'");
    await expect(
      second.query(
        'UPDATE product_variants SET current_supplier_id=$1 WHERE variant_id=$2',
        [other, variant],
      ),
    ).rejects.toMatchObject({ code: '55P03' });
    await second.rollbackTransaction();
    await second.release();
    await q.rollbackTransaction();
    await q.release();
  });
  for (const value of [-1, '9007199254740992'])
    it('objetivo inválido ' + value, async () => {
      await expect(
        db.query('UPDATE product_variants SET target_stock_atomic=$1', [value]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  it('documentos: identidad compuesta, FK, límite y rangos', async () => {
    const order = randomUUID(),
      order2 = randomUUID(),
      line = randomUUID(),
      receipt = randomUUID(),
      movement = randomUUID();
    await db.query(
      "INSERT INTO supplier_orders(id,supplier_id,status,occurred_at_ms,currency,supplier_name_snapshot) VALUES($1,$3,'confirmed',100,'MXN','Proveedor'),($2,$3,'confirmed',100,'MXN','Proveedor')",
      [order, order2, other],
    );
    const insertLine = async (position: number, quantity: number) =>
      db.query(
        "INSERT INTO supplier_order_items(id,order_id,variant_id,inventory_item_id,unit_id,product_name_snapshot,dimension,unit_code_snapshot,unit_symbol_snapshot,unit_atomic_factor,reference_quantity_atomic,quantity_atomic,quoted_price_minor,total_minor,position) VALUES($1,$2,$3,$4,$5,'Café','count','piece','pza',1,1,$6,0,0,$7)",
        [line, order, variant, item, unit, quantity, position],
      );
    await expect(insertLine(50, 1)).rejects.toMatchObject({ code: '23514' });
    await expect(insertLine(0, 0)).rejects.toMatchObject({ code: '23514' });
    await insertLine(0, 2);
    await db.query(
      'INSERT INTO supplier_receipts(id,order_id,event_id,intent_hash,base_event_id,occurred_at_ms,total_minor) VALUES($1,$2,$3,$4,$5,100,0)',
      [receipt, order, randomUUID(), 'a'.repeat(64), event],
    );
    await db.query(
      "INSERT INTO inventory_movements(movement_id,inventory_item_id,event_id,movement_type,quantity_delta_atomic,created_at_local) VALUES($1,$2,$3,'entry',1,now())",
      [movement, item, event],
    );
    await expect(
      db.query(
        'INSERT INTO supplier_receipt_items(id,receipt_id,order_id,order_item_id,quantity_atomic,actual_price_minor,total_minor,movement_id) VALUES($1,$2,$3,$4,1,0,0,$5)',
        [randomUUID(), receipt, order2, line, movement],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await db.query(
      'INSERT INTO supplier_receipt_items(id,receipt_id,order_id,order_item_id,quantity_atomic,actual_price_minor,total_minor,movement_id) VALUES($1,$2,$3,$4,1,0,0,$5)',
      [randomUUID(), receipt, order, line, movement],
    );
    await expect(
      db.query('DELETE FROM supplier_orders WHERE id=$1', [order]),
    ).rejects.toMatchObject({ code: '23001' });
    // These documents are schema fixtures; no stock handler is enabled by S1.
    expect(
      (
        await db.query('SELECT quantity_on_hand_atomic FROM inventory_balances')
      )[0].quantity_on_hand_atomic,
    ).toBe('17');
  });
  it('handler real de producto conserva selección durante reemplazo y revierte retirada legada', async () => {
    const conflicts = new SyncConflictService();
    const productHandler = new ProductoEventHandler(conflicts);
    const supplierHandler = new ProveedorEventHandler(conflicts);
    const sid1 = '00000000-0000-4000-8000-000000000002',
      sid2 = '00000000-0000-4000-8000-000000000003';
    const productId = randomUUID(),
      vid = '00000000-0000-4000-8000-000000000001';
    const envelope = (
      type: string,
      id: string,
      payload: Record<string, unknown>,
      eventId = randomUUID(),
    ): PushEventDto => ({
      event_id: eventId,
      aggregate_type: type.startsWith('proveedor_') ? 'supplier' : 'product',
      aggregate_id: id,
      event_type: type,
      device_id: 's1',
      user_id: 's1',
      base_version: 1,
      base_server_sequence: null,
      created_at_local: '2026-11-19T00:00:00.000Z',
      payload,
    });
    for (const [id, eid] of [
      [sid1, '00000000-0000-4000-8000-000000000004'],
      [sid2, randomUUID()],
    ]) {
      const result = await db.transaction((m) =>
        supplierHandler.apply(
          m,
          envelope(
            'proveedor_creado',
            id,
            { name: 'Proveedor de ensayo' },
            eid,
          ),
        ),
      );
      expect(result.status).toBe('accepted');
    }
    const creation = envelope(
      'producto_creado',
      productId,
      supplierFixture('producto_creado'),
    );
    expect(
      (await db.transaction((m) => productHandler.apply(m, creation))).status,
    ).toBe('accepted');
    await db.query(
      'UPDATE product_variants SET current_supplier_id=$1,target_stock_atomic=7 WHERE variant_id=$2',
      [sid1, vid],
    );
    const saved = await db.manager.findOneByOrFail(EventEntity, {
      eventId: creation.event_id,
    });
    const before = structuredClone(saved.payload) as any,
      after = structuredClone(before);
    after.product.name = 'Nombre actualizado';
    after.variants[0].suppliers[0].quoted_price_minor = 123;
    const row = await db.manager.findOneByOrFail(ProductEntity, {
      id: productId,
    });
    const update = envelope('producto_actualizado', productId, {
      base_event_id: creation.event_id,
      before,
      after,
    });
    update.base_version = row.version;
    update.base_server_sequence = row.lastServerSequence;
    expect(
      (await db.transaction((m) => productHandler.apply(m, update))).status,
    ).toBe('accepted');
    expect(
      (
        await db.query(
          'SELECT current_supplier_id,target_stock_atomic FROM product_variants WHERE variant_id=$1',
          [vid],
        )
      )[0],
    ).toEqual({ current_supplier_id: sid1, target_stock_atomic: '7' });
    const official = await db.manager.findOneByOrFail(EventEntity, {
      eventId: update.event_id,
    });
    const old = (official.payload as any).after,
      next = structuredClone(old);
    next.variants[0].suppliers = [];
    next.dependencies = [];
    const current = await db.manager.findOneByOrFail(ProductEntity, {
      id: productId,
    });
    const remove = envelope('producto_actualizado', productId, {
      base_event_id: update.event_id,
      before: old,
      after: next,
    });
    remove.base_version = current.version;
    remove.base_server_sequence = current.lastServerSequence;
    const state = await snapshot();
    await expect(
      db.transaction((m) => productHandler.apply(m, remove)),
    ).rejects.toThrow('Retire o sustituya');
    expect(await snapshot()).toEqual(state);
    const explicitBefore = structuredClone(old);
    explicitBefore.variants[0].current_supplier_id = sid1;
    explicitBefore.variants[0].target_stock_atomic = 7;
    const explicitAfter = structuredClone(explicitBefore);
    explicitAfter.variants[0].current_supplier_id = sid2;
    explicitAfter.variants[0].target_stock_atomic = 7;
    explicitAfter.variants[0].suppliers = [
      { supplier_id: sid2, quoted_price_minor: 0, quoted_at_ms: 100 },
    ];
    explicitAfter.dependencies = explicitAfter.dependencies.filter(
      (d: any) => d.ref_type !== 'supplier',
    );
    explicitAfter.dependencies.push({ ref_type: 'supplier', ref_id: sid2 });
    const replacement = envelope('producto_actualizado', productId, {
      base_event_id: update.event_id,
      before: explicitBefore,
      after: explicitAfter,
    });
    replacement.base_version = current.version;
    replacement.base_server_sequence = current.lastServerSequence;
    const replacementResult = await db.transaction((m) =>
      productHandler.apply(m, replacement),
    );
    expect(replacementResult.reason).toBeUndefined();
    expect(replacementResult.status).toBe('accepted');
    expect(
      (
        await db.query(
          'SELECT current_supplier_id,target_stock_atomic FROM product_variants WHERE variant_id=$1',
          [vid],
        )
      )[0],
    ).toEqual({ current_supplier_id: sid2, target_stock_atomic: '7' });
    expect(
      await db.query(
        'SELECT supplier_id,quoted_price_minor FROM variant_suppliers WHERE variant_id=$1',
        [vid],
      ),
    ).toEqual([{ supplier_id: sid2, quoted_price_minor: '0' }]);
  });
  it('downgrade protegido', async () => {
    await expect(db.undoLastMigration()).rejects.toThrow('Downgrade');
  });
});
