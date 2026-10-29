import { CashMovementEntity } from '../entities/cash-movement.entity';
import { CajaCerradaPayload } from './payloads/caja-cerrada.payload';
import { CashMovementEvidence } from './payloads/cash-movement-evidence';
import { CreateSaleReconciliationEffects1793232000000 } from '../migrations/1793232000000-CreateSaleReconciliationEffects';
import { SaleReconciliationCreditAllocationEntity } from '../entities/sale-reconciliation-credit-allocation.entity';
import { OperacionVentaConciliadaPayload } from './payloads/operacion-venta-conciliada.payload';
import { saleReconciliationEvidence } from './payloads/sale-reconciliation-evidence';
import { SaleReconciliationEffectEntity } from '../entities/sale-reconciliation-effect.entity';
import { ClienteEntity } from '../entities/cliente.entity';
import { CreditSaleEntity } from '../entities/credit-sale.entity';
import { CustomerPaymentEntity } from '../entities/customer-payment.entity';
import { CreditAllocationEntity } from '../entities/credit-allocation.entity';
import { AbonoClienteEventHandler } from './abono-cliente-event.handler';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { EventEntity } from '../entities/event.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { SaleEntity } from '../entities/sale.entity';
import { SaleItemEntity } from '../entities/sale-item.entity';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { ProductEntity } from '../entities/product.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { UnitEntity } from '../entities/unit.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { CashSessionEntity } from '../entities/cash-session.entity';
import { SaleAdjustmentEntity } from '../entities/sale-adjustment.entity';
import { SaleAdjustmentEventHandler } from './sale-adjustment-event.handler';
import { CustomerCreditProjector } from './customer-credit.projector';
import { SyncConflictService } from './sync-conflict.service';
import { CashEventHandler } from './cash-event.handler';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { EventsGateway } from '../events/events.gateway';
import { PushEventDto } from './dto/push-events.dto';
import { SaleAdjustmentPayloadData } from './payloads/sale-adjustment-data';
import { CreateSaleAdjustments1793145600000 } from '../migrations/1793145600000-CreateSaleAdjustments';
const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('Ajustes PostgreSQL + HTTP aislados', () => {
  jest.setTimeout(30000);
  let admin: DataSource,
    db: DataSource,
    service: SyncService,
    app: INestApplication;
  const schema = `adjustments_${process.pid}_${Date.now()}`;
  const fixture = JSON.parse(
    readFileSync(
      join(__dirname, '../../contracts/sale_adjustments/v1.json'),
      'utf8',
    ),
  ).cases[0];
  let p: SaleAdjustmentPayloadData, sequence: number;
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
    }).initialize();
    await db.synchronize();
    const conflicts = new SyncConflictService();
    service = new SyncService(
      db,
      { notifyEventsAvailable: () => {} } as unknown as EventsGateway,
      conflicts,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new AbonoClienteEventHandler(new CustomerCreditProjector(), conflicts),
      undefined,
      undefined,
      new CashEventHandler(conflicts),
      undefined,
      undefined,
      new SaleAdjustmentEventHandler(new CustomerCreditProjector(), conflicts),
    );
    const module = await Test.createTestingModule({
      controllers: [SyncController],
      providers: [{ provide: SyncService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE events, sales, products, units, inventory_items, clientes, cash_sessions, sync_conflicts CASCADE`,
    );
    p = structuredClone(fixture.payload);
    const original = fixture.original,
      line = original.lines[0],
      stock = line.consumptions[0],
      unit = randomUUID();
    await db.manager.insert(UnitEntity, {
      unitId: unit,
      code: 'piece',
      name: 'Pieza',
      symbol: 'pza',
      dimension: 'count',
      atomicFactor: '1',
      maxFractionDigits: 0,
    });
    await db.manager.insert(InventoryItemEntity, {
      id: stock.inventory_item_id,
      name: 'Historico',
      defaultUnitId: unit,
    });
    await db.manager.insert(InventoryBalanceEntity, {
      inventoryItemId: stock.inventory_item_id,
      quantityOnHandAtomic: '-2',
      quantityAvailableAtomic: '-2',
      lastEventId: p.confirmation_event_id,
    });
    await db.manager.insert(ProductEntity, {
      id: line.product_id,
      name: 'Historico',
    });
    await db.manager.insert(ProductVariantEntity, {
      id: line.snapshot.variant_id,
      productId: line.product_id,
      salePriceMinor: '500',
      standardCostMinor: '300',
      sortOrder: 0,
    });
    const event = await db.manager.save(
      EventEntity,
      db.manager.create(EventEntity, {
        eventId: p.confirmation_event_id,
        aggregateType: 'sale',
        aggregateId: p.sale_id,
        eventType: 'venta_confirmada',
        deviceId: 'A',
        userId: 'u',
        baseVersion: 1,
        createdAtLocal: new Date(p.occurred_at_ms - 1000),
        payload: original,
        syncStatus: EventSyncStatus.SYNCED,
      }),
    );
    sequence = Number(event.serverSequence);
    await db.manager.insert(SaleEntity, {
      id: p.sale_id,
      userId: 'u',
      deviceId: 'A',
      status: 'confirmada',
      totalMinor: '1000',
      currency: 'MXN',
      createdAtLocal: event.createdAtLocal,
      createdEventId: event.eventId,
    });
    await db.manager.insert(SaleItemEntity, {
      id: line.sale_item_id,
      saleId: p.sale_id,
      variantId: line.snapshot.variant_id,
      totalMinor: '1000',
      sortOrder: 0,
      snapshot: line,
    });
    await db.manager.insert(SalePaymentEntity, {
      id: original.payment_id,
      saleId: p.sale_id,
      method: 'cash',
      currency: 'MXN',
      amountMinor: '1000',
      receivedMinor: '2000',
      changeMinor: '1000',
      createdEventId: event.eventId,
    });
    await db.manager.insert(InventoryMovementEntity, {
      movementId: stock.movement_id,
      inventoryItemId: stock.inventory_item_id,
      saleItemId: line.sale_item_id,
      eventId: event.eventId,
      movementType: 'sale_consumption',
      quantityDeltaAtomic: '-2',
      createdAtLocal: event.createdAtLocal,
    });
    await db.manager.save(
      EventEntity,
      db.manager.create(EventEntity, {
        eventId: p.settlement.cash!.opening_event_id as string,
        aggregateType: 'cash_session',
        aggregateId: p.settlement.cash!.session_id as string,
        eventType: 'caja_abierta',
        deviceId: 'A',
        userId: 'u',
        createdAtLocal: event.createdAtLocal,
        payload: {},
        syncStatus: EventSyncStatus.SYNCED,
      }),
    );
    await db.manager.insert(CashSessionEntity, {
      id: p.settlement.cash!.session_id as string,
      deviceId: 'A',
      openedByUserId: 'u',
      status: 'open',
      openedAtMs: String(p.occurred_at_ms - 2000),
      openingMinor: '1000',
      createdEventId: p.settlement.cash!.opening_event_id as string,
    });
  });
  function envelope(payload = p): PushEventDto {
    return {
      event_id: payload.event_id,
      aggregate_type: 'sale',
      aggregate_id: payload.sale_id,
      event_type:
        payload.kind === 'void'
          ? 'venta_anulada'
          : 'devolucion_venta_registrada',
      device_id: 'A',
      user_id: 'u',
      base_version: payload.expected_revision + 1,
      base_server_sequence: sequence,
      created_at_local: new Date(payload.occurred_at_ms).toISOString(),
      payload: { ...payload },
    };
  }
  async function push(e: PushEventDto) {
    const r = await request(app.getHttpServer())
      .post('/sync/push')
      .send({ device_id: e.device_id, events: [e] })
      .expect(201);
    return r.body.results[0];
  }
  function partial() {
    const r = structuredClone(p);
    r.kind = 'return';
    r.event_id = randomUUID();
    r.operation_id = randomUUID();
    r.total_minor = 500;
    r.lines[0].quantity_atomic = 1;
    r.lines[0].amount_minor = 500;
    r.lines[0].recovered_cost_minor = 300;
    r.lines[0].destination = 'restock';
    r.lines[0].stock[0].quantity_atomic = 1;
    r.lines[0].stock[0].movement_id = randomUUID();
    if (r.settlement.cash) r.settlement.cash.movement_id = randomUUID();
    return r;
  }
  const snapshot = async () =>
    Promise.all(
      [
        'events',
        'event_refs',
        'sale_adjustments',
        'sale_adjustment_lines',
        'inventory_movements',
        'inventory_balances',
        'cash_movements',
        'sale_credit_reductions',
        'credit_allocations',
      ].map((t) => db.query(`SELECT * FROM ${t} ORDER BY 1`)),
    );
  it('S03/S05 HTTP acepta, conserva originales, duplicate y pull/preflight', async () => {
    const original = await db.manager.find(SaleEntity);
    const accepted = await push(envelope());
    expect(accepted.status).toBe('accepted');
    expect((await push(envelope())).original_sync_status).toBe('synced');
    expect(await db.manager.find(SaleEntity)).toEqual(original);
    expect(
      (
        await db.manager.findOneByOrFail(InventoryBalanceEntity, {
          inventoryItemId: p.lines[0].stock[0].inventory_item_id,
        })
      ).quantityOnHandAtomic,
    ).toBe('0');
    expect(
      (await service.pullEvents({ since: sequence, limit: 1 })).has_more,
    ).toBe(true);
    expect(
      (
        await service.preflightEvents({
          device_id: 'B',
          last_full_pull_server_sequence: sequence,
          pending_refs: [
            { aggregate_type: 'sale', aggregate_id: p.sale_id, refs: [] },
          ],
          max_events: 1,
        })
      ).events.at(-1)?.event_id,
    ).toBe(p.event_id);
  });
  it('S04 manipulación rechaza sin efectos; S06 contenido diferente rápido', async () => {
    const bad = structuredClone(p);
    bad.total_minor++;
    expect((await push(envelope(bad))).status).toBe('rejected');
    expect(await db.manager.count(SaleAdjustmentEntity)).toBe(0);
    expect((await push(envelope())).status).toBe('rejected');
  });
  it('S06 carrera mismo eventId, diferente contenido', async () => {
    const other = structuredClone(p);
    other.reason = 'Otro motivo';
    const r = await Promise.all([push(envelope()), push(envelope(other))]);
    expect(r.map((v) => v.status).sort()).toEqual(['accepted', 'rejected']);
    expect(await db.manager.count(SaleAdjustmentEntity)).toBe(1);
  });
  it('S12 dos parciales caben pero una base gana', async () => {
    const r = await Promise.all([
      push(envelope(partial())),
      push(envelope(partial())),
    ]);
    expect(r.map((v) => v.status).sort()).toEqual(['accepted', 'conflict']);
  });
  it('S13 anulación contra devolución y sobredevolución', async () => {
    const r = await Promise.all([push(envelope()), push(envelope(partial()))]);
    expect(r.map((v) => v.status).sort()).toEqual(['accepted', 'conflict']);
  });
  it.each([
    'events',
    'sale_adjustments',
    'sale_adjustment_lines',
    'inventory_movements',
    'inventory_balances',
    'cash_movements',
    'event_refs',
  ])('S03 rollback real tras escribir %s', async (table) => {
    const before = await snapshot();
    await db.query(
      `CREATE FUNCTION fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`,
    );
    await db.query(
      `CREATE TRIGGER fail_write AFTER INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_write()`,
    );
    try {
      await expect(
        service.pushEvents({ device_id: 'A', events: [envelope()] }),
      ).rejects.toThrow('injected');
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.query(`DROP TRIGGER fail_write ON ${table}`);
      await db.query('DROP FUNCTION fail_write()');
    }
    expect((await push(envelope())).status).toBe('accepted');
  });
  async function creditSetup() {
    const cliente = randomUUID(),
      clientEvent = randomUUID();
    await db.manager.insert(ClienteEntity, {
      id: cliente,
      nombre: 'Cliente',
      createdEventId: clientEvent,
    });
    await db.manager.save(
      EventEntity,
      db.manager.create(EventEntity, {
        eventId: clientEvent,
        aggregateType: 'cliente',
        aggregateId: cliente,
        eventType: 'cliente_creado',
        deviceId: 'A',
        userId: 'u',
        createdAtLocal: new Date(p.occurred_at_ms - 2000),
        payload: {},
        syncStatus: EventSyncStatus.SYNCED,
      }),
    );
    const event = await db.manager.findOneByOrFail(EventEntity, {
      eventId: p.confirmation_event_id,
    });
    event.payload = {
      ...event.payload,
      payment_method: 'credit',
      payment_id: null,
      received_minor: 0,
      change_minor: 0,
      cliente_id: cliente,
      cliente_event_id: clientEvent,
      cliente_nombre: 'Cliente',
      occurred_at_ms: p.occurred_at_ms - 1000,
      dependency_event_ids: [
        ...(event.payload.dependency_event_ids as string[]),
        clientEvent,
      ],
    };
    await db.manager.save(event);
    await db.manager.update(
      SaleEntity,
      { id: p.sale_id },
      { clienteId: cliente },
    );
    await db.manager.delete(SalePaymentEntity, { saleId: p.sale_id });
    await db.manager.insert(CreditSaleEntity, {
      id: p.sale_id,
      saleId: p.sale_id,
      clienteId: cliente,
      amountMinor: '1000',
      occurredAtMs: String(p.occurred_at_ms - 1000),
      createdEventId: p.confirmation_event_id,
    });
    await db.manager.insert(CustomerPaymentEntity, {
      id: randomUUID(),
      clienteId: cliente,
      amountMinor: '800',
      method: 'transfer',
      occurredAtMs: String(p.occurred_at_ms - 500),
    });
    await db.transaction((m) =>
      new CustomerCreditProjector().rebuild(m, cliente),
    );
    p.settlement = {
      method: 'credit',
      payment_id: null,
      cliente_id: cliente,
      action: 'credit_reduction',
      reference: null,
      cash_enabled: true,
      cash: null,
    };
    p.dependency_event_ids = [p.confirmation_event_id];
    return { cliente, clientEvent };
  }
  it.each(['sale_credit_reductions', 'credit_allocations'])(
    'S03 crédito rollback %s',
    async (table) => {
      await creditSetup();
      const before = await snapshot();
      await db.query(
        `CREATE FUNCTION fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`,
      );
      await db.query(
        `CREATE TRIGGER fail_write AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_write()`,
      );
      try {
        await expect(
          service.pushEvents({ device_id: 'A', events: [envelope()] }),
        ).rejects.toThrow('injected');
        expect(await snapshot()).toEqual(before);
      } finally {
        await db.query(`DROP TRIGGER fail_write ON ${table}`);
        await db.query('DROP FUNCTION fail_write()');
      }
      expect((await push(envelope())).status).toBe('accepted');
      expect(await db.manager.count(CreditAllocationEntity)).toBe(0);
    },
  );
  async function prepareReconciliation(): Promise<PushEventDto> {
    const losing = structuredClone(p);
    const winning = partial();
    const accepted = await push(envelope(winning));
    expect(accepted.status).toBe('accepted');
    expect((await push(envelope(losing))).status).toBe('conflict');
    const at = losing.occurred_at_ms + 10000;
    const contract = OperacionVentaConciliadaPayload.fromJson({
      schema_version:1,operation_id:randomUUID(),event_id:randomUUID(),incident_id:losing.event_id,
      sale_id:losing.sale_id,loser_event_id:losing.event_id,winner_event_id:winning.event_id,
      official_base_event_id:winning.event_id,expected_revision:1,occurred_at_ms:at,
      utc_offset_minutes:0,business_date:new Date(at).toISOString().slice(0,10),
      reason:'Reconocimiento explícito del exceso documentado, sin otra devolución.',
      preserved_effects:saleReconciliationEvidence(losing),recovery_effects:[],
    });
    return {...envelope(losing),event_id:contract.data.event_id,event_type:OperacionVentaConciliadaPayload.eventType,base_version:2,base_server_sequence:accepted.server_sequence!,created_at_local:new Date(at).toISOString(),payload:contract.toJson()};
  }
  it('4B migración explícita up/down conserva historia y rechaza retirar evidencia',async()=>{
    const runner=db.createQueryRunner();await runner.connect();
    try {
      await runner.query('DROP TABLE sale_reconciliation_credit_allocations');
      await runner.query('DROP TABLE sale_reconciliation_effects');
      const migration=new CreateSaleReconciliationEffects1793232000000();
      await migration.up(runner);await migration.down(runner);await migration.up(runner);
      const e=await prepareReconciliation();expect((await push(e)).status).toBe('accepted');
      await expect(migration.down(runner)).rejects.toThrow('evidencia');
    }finally{await runner.release();}
  });
  it('S17 crédito independiente conserva deuda/abonos y deriva FIFO separado',async()=>{
    await creditSetup();
    const originalCredit=await db.manager.find(CreditSaleEntity);
    const originalPayments=await db.manager.find(CustomerPaymentEntity);
    const e=await prepareReconciliation();expect((await push(e)).status).toBe('accepted');
    expect(await db.manager.find(CreditSaleEntity)).toEqual(originalCredit);
    expect(await db.manager.find(CustomerPaymentEntity)).toEqual(originalPayments);
    const effects=await db.manager.find(SaleReconciliationEffectEntity,{where:{ledger:'credit'}});
    expect(effects.reduce((n,x)=>n+BigInt(x.delta),0n)).toBe(1000n);
    const account=await db.manager.find(SaleReconciliationCreditAllocationEntity);
    // El abono anterior de 800 cubre primero el cargo neto 500; la nota de
    // conciliación queda disponible, sin fabricar un abono para representarla.
    expect(account).toHaveLength(0);
    expect(await db.manager.count(CustomerPaymentEntity)).toBe(originalPayments.length);
  });
  it('S16/S17 reconocimiento independiente, respuesta perdida y cantidades comerciales intactas',async()=>{
    const e=await prepareReconciliation();
    const before=await db.manager.find(InventoryBalanceEntity);
    const result=await push(e);expect(result.status).toBe('accepted');
    const effects=await db.manager.find(SaleReconciliationEffectEntity);
    expect(effects.length).toBeGreaterThan(0);
    expect(await db.manager.count(SaleAdjustmentEntity)).toBe(1);
    const after=await db.manager.find(InventoryBalanceEntity);
    for(const b of after) expect(BigInt(b.quantityOnHandAtomic)-BigInt(before.find(x=>x.inventoryItemId===b.inventoryItemId)!.quantityOnHandAtomic)).toBe(effects.filter(x=>x.ledger==='stock'&&x.targetId===b.inventoryItemId).reduce((n,x)=>n+BigInt(x.delta),0n));
    const duplicate=await push(e);expect(duplicate.status).toBe('duplicate');expect(duplicate.original_sync_status).toBe('synced');
    expect(await db.manager.find(InventoryBalanceEntity)).toEqual(after);
    const changed=structuredClone(e);changed.payload.reason='Otra declaración';expect((await push(changed)).status).toBe('rejected');
  });
  it('S17 recuperación explícita en caja actual, dos efectos y corte histórico inmutable',async()=>{
    const e=await prepareReconciliation();
    const contract=OperacionVentaConciliadaPayload.fromJson(e.payload);
    const data=contract.data;
    const money=data.preserved_effects.find(x=>x.ledger==='cash')!;
    const stock=data.preserved_effects.find(x=>x.ledger==='stock')!;
    const oldCuts=await db.manager.find(CashSessionEntity,{where:{status:'closed'}});
    data.recovery_effects=[{...stock,effect_id:randomUUID(),delta:-stock.delta},...[1,2].map(()=>({...money,effect_id:randomUUID(),delta:500,occurred_at_ms:data.occurred_at_ms,utc_offset_minutes:data.utc_offset_minutes,business_date:data.business_date}))];
    e.payload=OperacionVentaConciliadaPayload.fromJson({...data}).toJson();
    const balanceBefore=await db.manager.find(InventoryBalanceEntity);
    expect((await push(e)).status).toBe('accepted');
    expect(await db.manager.find(InventoryBalanceEntity)).toEqual(balanceBefore.map(b=>({...b,lastEventId:e.event_id,lastServerSequence:expect.any(String)})));
    const session=await db.manager.findOneByOrFail(CashSessionEntity,{id:money.cash_session_id!});
    const handler=new CashEventHandler(new SyncConflictService());
    const evidence=(await db.manager.find(CashMovementEntity,{where:{sessionId:session.id}})).map(x=>handler.evidence(x));
    for(const r of [...data.preserved_effects,...data.recovery_effects].filter(x=>x.ledger==='cash'&&x.cash_session_id===session.id)) evidence.push(CashMovementEvidence.fromJson({movement_id:r.effect_id,event_id:e.event_id,direction:r.delta>0?'in':'out',amount_minor:Math.abs(r.delta),source_type:'sale_reconciliation',source_id:data.operation_id}));
    const income=evidence.filter(x=>x.direction==='in').reduce((n,x)=>n+BigInt(x.amountMinor),0n);
    const expense=evidence.filter(x=>x.direction==='out').reduce((n,x)=>n+BigInt(x.amountMinor),0n);
    const expected=BigInt(session.openingMinor)+income-expense;
    const close= CajaCerradaPayload.fromJson({opening_event_id:session.createdEventId,closed_at_ms:data.occurred_at_ms+1000,counted_minor:Number(expected),income_minor:String(income),expense_minor:String(expense),expected_minor:String(expected),difference_minor:'0',notes:null,movements:evidence.map(x=>x.toJson())});
    const event:PushEventDto={event_id:randomUUID(),aggregate_type:'cash_session',aggregate_id:session.id,event_type:'caja_cerrada',device_id:e.device_id,user_id:e.user_id,base_version:1,created_at_local:new Date(close.closedAtMs).toISOString(),payload:close.toJson()};
    expect((await push(event)).status).toBe('accepted');
    for(const old of oldCuts) expect(await db.manager.findOneBy(CashSessionEntity,{id:old.id})).toEqual(old);
  });
  it('S17 revisión obsoleta y evidencia manipulada conservan incidencia sin consumo',async()=>{
    const e=await prepareReconciliation();
    const stale=structuredClone(e);stale.payload.expected_revision=0;stale.base_version=1;
    expect((await push(stale)).status).toBe('conflict');
    const wrong=structuredClone(e);wrong.event_id=randomUUID();wrong.payload.event_id=wrong.event_id;wrong.payload.operation_id=randomUUID();
    (wrong.payload.preserved_effects as Array<{delta:number}>)[0].delta++;
    expect((await push(wrong)).status).toBe('rejected');
    expect(await db.manager.count(SaleReconciliationEffectEntity)).toBe(0);
    const valid=structuredClone(e);valid.event_id=randomUUID();valid.payload.event_id=valid.event_id;valid.payload.operation_id=randomUUID();
    expect((await push(valid)).status).toBe('accepted');
  });
  it.each(['sale_reconciliation_effects','inventory_balances','event_refs'])('S17 rollback de reconocimiento tras %s',async(table)=>{
    const e=await prepareReconciliation();
    const before=await db.manager.find(InventoryBalanceEntity);
    await db.query(`CREATE FUNCTION reject_reconciliation_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reconciliation failure'; END $$`);
    await db.query(`CREATE TRIGGER fail_reconciliation AFTER INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_write()`);
    try { await expect(push(e)).rejects.toThrow(); } finally { await db.query(`DROP TRIGGER fail_reconciliation ON ${table}`);await db.query('DROP FUNCTION reject_reconciliation_write()'); }
    expect(await db.manager.count(SaleReconciliationEffectEntity)).toBe(0);
    expect(await db.manager.find(InventoryBalanceEntity)).toEqual(before);
    expect(await db.manager.existsBy(EventEntity,{eventId:e.event_id})).toBe(false);
    expect((await push(e)).status).toBe('accepted');
  });
  it('S14 abono concurrente con devolución crédito, FIFO neto', async () => {
    const { cliente, clientEvent } = await creditSetup();
    const adjustment = partial();
    adjustment.settlement = { ...p.settlement };
    const abono: PushEventDto = {
      event_id: randomUUID(),
      aggregate_type: 'customer_payment',
      aggregate_id: randomUUID(),
      event_type: 'abono_cliente_registrado',
      device_id: 'B',
      user_id: 'u',
      base_version: 1,
      created_at_local: new Date(p.occurred_at_ms).toISOString(),
      payload: {
        cliente_id: cliente,
        cliente_event_id: clientEvent,
        amount_minor: 100,
        occurred_at_ms: p.occurred_at_ms,
        method: 'transfer',
        reference: null,
        currency: 'MXN',
      },
    };
    const results = await Promise.all([
      push(envelope(adjustment)),
      push(abono),
    ]);
    expect(results.map((v) => v.status)).toEqual(['accepted', 'accepted']);
    expect(
      (await db.manager.find(CreditAllocationEntity)).reduce(
        (n, r) => n + Number(r.amountMinor),
        0,
      ),
    ).toBe(500);
    expect(
      (await db.manager.findOneByOrFail(CreditSaleEntity, { id: p.sale_id }))
        .amountMinor,
    ).toBe('1000');
  });
  it('S15 corte espera ajuste, conserva evidencia y no acepta operación posterior en caja cerrada', async () => {
    const cash = p.settlement.cash!;
    const close: PushEventDto = {
      event_id: randomUUID(),
      aggregate_type: 'cash_session',
      aggregate_id: cash.session_id as string,
      event_type: 'caja_cerrada',
      device_id: 'A',
      user_id: 'u',
      base_version: 1,
      created_at_local: new Date(p.occurred_at_ms + 1000).toISOString(),
      payload: {
        opening_event_id: cash.opening_event_id,
        closed_at_ms: p.occurred_at_ms + 1000,
        counted_minor: 0,
        income_minor: '0',
        expense_minor: '1000',
        expected_minor: '0',
        difference_minor: '0',
        notes: null,
        movements: [
          {
            movement_id: cash.movement_id,
            event_id: p.event_id,
            direction: 'out',
            amount_minor: 1000,
            source_type: 'sale_adjustment',
            source_id: p.operation_id,
          },
        ],
      },
    };
    expect((await push(close)).status).toBe('pending');
    expect((await push(envelope())).status).toBe('accepted');
    expect((await push(close)).status).toBe('accepted');
    const next = partial();
    expect((await push(envelope(next))).status).toBe('conflict');
    expect(
      (
        await db.manager.findOneByOrFail(CashSessionEntity, {
          id: close.aggregate_id,
        })
      ).status,
    ).toBe('closed');
  });
  it('S08 ausente permanece transitorio y terminal conserva incidencia', async () => {
    p.dependency_event_ids.push(randomUUID());
    expect((await push(envelope())).status).toBe('pending');
    expect(
      await db.manager.existsBy(EventEntity, { eventId: p.event_id }),
    ).toBe(false);
    const dep = p.dependency_event_ids.at(-1)!;
    await db.manager.save(
      EventEntity,
      db.manager.create(EventEntity, {
        eventId: dep,
        aggregateType: 'sale',
        aggregateId: p.sale_id,
        eventType: 'venta_confirmada',
        deviceId: 'B',
        userId: 'u',
        createdAtLocal: new Date(p.occurred_at_ms),
        payload: {},
        syncStatus: EventSyncStatus.REJECTED,
      }),
    );
    expect((await push(envelope())).status).toBe('conflict');
  });
  it('S06 operation_id concurrente con eventos distintos rechaza colisión', async () => {
    const other = structuredClone(p);
    other.event_id = randomUUID();
    other.reason = 'Otra intención';
    const r = await Promise.all([push(envelope()), push(envelope(other))]);
    expect(r.map((v) => v.status).sort()).toEqual(['accepted', 'rejected']);
    expect(await db.manager.count(SaleAdjustmentEntity)).toBe(1);
  });
  it('S09 preflight parcial exige pull completo; S13 acumulado impide sobredevolución', async () => {
    const first = partial();
    const accepted = await push(envelope(first));
    expect(accepted.status).toBe('accepted');
    const excess = partial();
    excess.expected_revision = 1;
    excess.previous_adjustment_event_id = first.event_id;
    excess.dependency_event_ids.push(first.event_id);
    excess.lines[0].quantity_atomic = 2;
    expect(
      (
        await push({
          ...envelope(excess),
          base_server_sequence: accepted.server_sequence,
        })
      ).status,
    ).toBe('rejected');
    const second = partial();
    second.expected_revision = 1;
    second.previous_adjustment_event_id = first.event_id;
    second.dependency_event_ids.push(first.event_id);
    expect(
      (
        await push({
          ...envelope(second),
          base_server_sequence: accepted.server_sequence,
        })
      ).status,
    ).toBe('accepted');
    const page = await service.preflightEvents({
      device_id: 'B',
      last_full_pull_server_sequence: sequence,
      max_events: 1,
      pending_refs: [
        { aggregate_type: 'sale', aggregate_id: p.sale_id, refs: [] },
      ],
    });
    expect(page.has_more).toBe(true);
    expect(page.requires_full_pull_before_push).toBe(true);
    expect(page.events).toHaveLength(1);
    expect(
      (
        await service.pullEvents({
          since: page.events[0].server_sequence,
          limit: 1,
        })
      ).events[0].event_id,
    ).toBe(second.event_id);
  });
  it('S14 dos ventas comparten recurso, locks ordenados sin perder saldo', async () => {
    const second = structuredClone(p),
      original = structuredClone(fixture.original);
    second.operation_id = randomUUID();
    second.event_id = randomUUID();
    second.sale_id = randomUUID();
    second.confirmation_event_id = randomUUID();
    original.payment_id = randomUUID();
    original.lines[0].sale_item_id = randomUUID();
    original.lines[0].consumptions[0].movement_id = randomUUID();
    second.settlement.payment_id = original.payment_id;
    second.lines[0].sale_item_id = original.lines[0].sale_item_id;
    second.lines[0].stock[0].original_movement_id =
      original.lines[0].consumptions[0].movement_id;
    second.lines[0].stock[0].movement_id = randomUUID();
    for (const value of [p, second]) {
      value.settlement.cash_enabled = false;
      value.settlement.cash = null;
      value.dependency_event_ids = [value.confirmation_event_id];
    }
    const confirmation = await db.manager.save(
      EventEntity,
      db.manager.create(EventEntity, {
        eventId: second.confirmation_event_id,
        aggregateType: 'sale',
        aggregateId: second.sale_id,
        eventType: 'venta_confirmada',
        deviceId: 'B',
        userId: 'u',
        baseVersion: 1,
        createdAtLocal: new Date(p.occurred_at_ms - 1000),
        payload: original,
        syncStatus: EventSyncStatus.SYNCED,
      }),
    );
    await db.manager.insert(SaleEntity, {
      id: second.sale_id,
      userId: 'u',
      deviceId: 'B',
      status: 'confirmada',
      totalMinor: '1000',
      currency: 'MXN',
      createdAtLocal: confirmation.createdAtLocal,
      createdEventId: confirmation.eventId,
    });
    await db.manager.insert(SaleItemEntity, {
      id: original.lines[0].sale_item_id,
      saleId: second.sale_id,
      variantId: original.lines[0].snapshot.variant_id,
      totalMinor: '1000',
      sortOrder: 0,
      snapshot: original.lines[0],
    });
    await db.manager.insert(SalePaymentEntity, {
      id: original.payment_id,
      saleId: second.sale_id,
      method: 'cash',
      currency: 'MXN',
      amountMinor: '1000',
      receivedMinor: '2000',
      changeMinor: '1000',
      createdEventId: confirmation.eventId,
    });
    await db.manager.insert(InventoryMovementEntity, {
      movementId: original.lines[0].consumptions[0].movement_id,
      inventoryItemId: original.lines[0].consumptions[0].inventory_item_id,
      saleItemId: original.lines[0].sale_item_id,
      eventId: confirmation.eventId,
      movementType: 'sale_consumption',
      quantityDeltaAtomic: '-2',
      createdAtLocal: confirmation.createdAtLocal,
    });
    await db.manager.update(
      InventoryBalanceEntity,
      { inventoryItemId: original.lines[0].consumptions[0].inventory_item_id },
      { quantityOnHandAtomic: '-4', quantityAvailableAtomic: '-4' },
    );
    const results = await Promise.all([
      push(envelope()),
      push({
        ...envelope(second),
        device_id: 'B',
        base_server_sequence: confirmation.serverSequence,
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    expect(
      (
        await db.manager.findOneByOrFail(InventoryBalanceEntity, {
          inventoryItemId: original.lines[0].consumptions[0].inventory_item_id,
        })
      ).quantityOnHandAtomic,
    ).toBe('0');
  });
  it.each(['payment', 'consumption', 'quantity', 'cost', 'method'])(
    'S04 %s manipulado no produce proyección parcial',
    async (field) => {
      if (field === 'payment') p.settlement.payment_id = randomUUID();
      if (field === 'consumption')
        p.lines[0].stock[0].original_movement_id = randomUUID();
      if (field === 'quantity') p.lines[0].stock[0].quantity_atomic++;
      if (field === 'cost') p.lines[0].recovered_cost_minor!++;
      if (field === 'method') p.settlement.method = 'transfer';
      const before = await db.manager.find(InventoryBalanceEntity);
      expect((await push(envelope())).status).toBe('rejected');
      expect(await db.manager.find(InventoryBalanceEntity)).toEqual(before);
      expect(await db.manager.count(SaleAdjustmentEntity)).toBe(0);
      expect((await db.query('SELECT * FROM cash_movements')).length).toBe(0);
    },
  );
  it('S02 migración explícita up/down y protección de evidencia', async () => {
    const q = db.createQueryRunner();
    await q.connect();
    const migration = new CreateSaleAdjustments1793145600000();
    try {
      await q.startTransaction();
      await migration.down(q);
      await migration.up(q);
      await q.commitTransaction();
      expect((await push(envelope())).status).toBe('accepted');
      await expect(migration.down(q)).rejects.toThrow('evidencia');
    } finally {
      if (q.isTransactionActive) await q.rollbackTransaction();
      await q.release();
    }
  });
});
