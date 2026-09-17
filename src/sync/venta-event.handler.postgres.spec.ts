import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { SaleEntity } from '../entities/sale.entity';
import { SaleItemEntity } from '../entities/sale-item.entity';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { ProductEntity } from '../entities/product.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { CategoryEntity } from '../entities/category.entity';
import { UnitEntity } from '../entities/unit.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { SyncConflictParticipantEntity } from '../entities/sync-conflict-participant.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { SaleMode } from '../enums/sale-mode.enum';
import { VentaEventHandler } from './venta-event.handler';
import { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';
import { EventsGateway } from '../events/events.gateway';
import { PushEventDto } from './dto/push-events.dto';
import {
  VentaConfirmadaPayload,
  rounded,
} from './payloads/venta-confirmada.payload';

const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('Venta efectivo PostgreSQL aislado', () => {
  jest.setTimeout(30000);
  let admin: DataSource, db: DataSource, service: SyncService;
  const schema = `cash_it_${process.pid}_${Date.now()}`;
  const handler = new VentaEventHandler(new SyncConflictService());
  let productId: string,
    variantId: string,
    itemId: string,
    configId: string,
    unitId: string;
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
      synchronize: true,
      entities: [
        EventEntity,
        EventRefEntity,
        SaleEntity,
        SaleItemEntity,
        SalePaymentEntity,
        ProductEntity,
        ProductVariantEntity,
        CategoryEntity,
        UnitEntity,
        InventoryItemEntity,
        InventoryBalanceEntity,
        InventoryMovementEntity,
        SyncConflictEntity,
        SyncConflictParticipantEntity,
      ],
    });
    await db.initialize();
    service = new SyncService(
      db,
      { notifyEventsAvailable: jest.fn() } as unknown as EventsGateway,
      new SyncConflictService(),
      undefined,
      undefined,
      undefined,
      handler,
    );
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE "${schema}".events, "${schema}".products, "${schema}".inventory_items, "${schema}".units, "${schema}".sales, "${schema}".sync_conflicts CASCADE`,
    );
    productId = randomUUID();
    variantId = randomUUID();
    itemId = randomUUID();
    configId = randomUUID();
    unitId = randomUUID();
    await db.manager.insert(UnitEntity, {
      unitId,
      code: 'piece',
      name: 'Pieza',
      symbol: 'pza',
      dimension: 'count',
      atomicFactor: '1',
      maxFractionDigits: 0,
      active: true,
    });
    await db.manager.insert(InventoryItemEntity, {
      id: itemId,
      defaultUnitId: unitId,
      name: 'Recurso',
    });
    await db.manager.insert(InventoryBalanceEntity, {
      inventoryItemId: itemId,
      quantityOnHandAtomic: '0',
      quantityAvailableAtomic: '0',
      lastEventId: configId,
    });
    await seedConfiguration('direct', false);
  });
  async function seedConfiguration(
    mode: 'none' | 'direct' | 'recipe',
    measured: boolean,
  ) {
    const saleConfig = measured
      ? {
          mode: 'measured',
          sale_unit_id: unitId,
          price_reference_quantity_atomic: 2,
        }
      : { mode: 'unit' };
    await db.manager.save(ProductEntity, {
      id: productId,
      name: 'Café',
      saleMode: measured ? SaleMode.MEASURED : SaleMode.UNIT,
      saleUnitId: measured ? unitId : null,
      priceReferenceQuantityAtomic: measured ? '2' : null,
    });
    await db.manager.save(ProductVariantEntity, {
      id: variantId,
      productId,
      salePriceMinor: '10000',
      sortOrder: 0,
      inventoryItemId: mode === 'direct' ? itemId : null,
    });
    await db.manager.save(EventEntity, {
      eventId: configId,
      aggregateType: 'product',
      aggregateId: productId,
      eventType: 'producto_creado',
      deviceId: 'tablet',
      userId: 'user',
      createdAtLocal: new Date(),
      syncStatus: EventSyncStatus.SYNCED,
      payload: {
        product: {
          name: 'Café',
          category_id: null,
          sale_configuration: saleConfig,
        },
        variants: [
          {
            variant_id: variantId,
            name: null,
            sale_price_minor: 10000,
            standard_cost_minor: null,
            inventory_item_id: mode === 'direct' ? itemId : null,
            inventory_configuration:
              mode === 'recipe'
                ? {
                    enabled: true,
                    components: [
                      { inventory_item_id: itemId, quantity_atomic: 3 },
                    ],
                  }
                : null,
            sort_order: 0,
          },
        ],
        dependencies: [
          ...(mode === 'none'
            ? []
            : [{ ref_type: 'inventory_item', ref_id: itemId }]),
          ...(measured ? [{ ref_type: 'unit', ref_id: unitId }] : []),
        ],
      },
    });
  }
  function sale(
    mode: 'none' | 'direct' | 'recipe' = 'direct',
    measured = false,
  ): PushEventDto {
    return {
      event_id: randomUUID(),
      aggregate_type: 'sale',
      aggregate_id: randomUUID(),
      event_type: 'venta_confirmada',
      device_id: 'tablet',
      user_id: 'user',
      created_at_local: new Date().toISOString(),
      base_version: 1,
      payload: {
        payment_id: randomUUID(),
        payment_method: 'cash',
        currency: 'MXN',
        total_minor: measured ? 5000 : 10000,
        received_minor: 20000,
        change_minor: measured ? 15000 : 10000,
        dependency_event_ids: [configId],
        lines: [
          {
            sale_item_id: randomUUID(),
            product_id: productId,
            configuration_event_id: configId,
            consumption_mode: mode,
            sale_unit_id: measured ? unitId : null,
            snapshot: {
              variant_id: variantId,
              product_name_snapshot: 'Café',
              variant_name_snapshot: null,
              sale_mode_snapshot: measured ? 'measured' : 'unit',
              quantity: measured ? null : 1,
              measured_quantity_atomic: measured ? 1 : null,
              unit_price_minor: 10000,
              standard_cost_minor_snapshot: 900,
              price_reference_quantity_atomic_snapshot: measured ? 2 : null,
              sale_unit_code_snapshot: measured ? 'piece' : null,
              sale_unit_symbol_snapshot: measured ? 'pza' : null,
              sale_unit_atomic_factor_snapshot: measured ? 1 : null,
            },
            consumptions:
              mode === 'none'
                ? []
                : [
                    {
                      inventory_item_id: itemId,
                      component_atomic: mode === 'recipe' ? 3 : 1,
                      quantity_delta_atomic:
                        mode === 'recipe' ? (measured ? -2 : -3) : -1,
                      movement_id: randomUUID(),
                      movement_type: 'sale_consumption',
                      total_cost_minor: null,
                    },
                  ],
          },
        ],
      },
    };
  }
  const push = async (e: PushEventDto) =>
    (await service.pushEvents({ device_id: e.device_id, events: [e] }))
      .results[0];
  it.each(['none', 'direct', 'recipe'] as const)(
    'persiste %s unit y measured, redondeo y saldo negativo',
    async (mode) => {
      for (const measured of [false, true]) {
        await seedConfiguration(mode, measured);
        const e = sale(mode, measured),
          result = await push(e);
        expect(result.status).toBe('accepted');
        const payment = await db.manager.findOneByOrFail(SalePaymentEntity, {
          saleId: e.aggregate_id,
        });
        expect(payment.receivedMinor).toBe('20000');
        expect(payment.amountMinor).toBe(measured ? '5000' : '10000');
      }
      const movements = await db.manager.find(InventoryMovementEntity);
      expect(movements).toHaveLength(mode === 'none' ? 0 : 2);
      expect(movements.every((m) => m.totalCostMinor === null)).toBe(true);
      expect(
        (
          await db.manager.findOneByOrFail(InventoryBalanceEntity, {
            inventoryItemId: itemId,
          })
        ).quantityOnHandAtomic,
      ).toBe(mode === 'none' ? '0' : mode === 'recipe' ? '-5' : '-2');
    },
  );
  it('respuesta perdida: reintento, pull y confirmación con otro evento', async () => {
    const e = sale();
    expect((await push(e)).status).toBe('accepted');
    const retry = await push(e);
    expect(retry.status).toBe('duplicate');
    expect(retry.original_sync_status).toBe('synced');
    const another = { ...sale(), aggregate_id: e.aggregate_id };
    expect((await push(another)).status).toBe('conflict');
    expect((await push(another)).original_sync_status).toBe('conflict');
    const pull = await service.pullEvents({ since: 0 });
    expect(pull.events.some((v) => v.event_id === e.event_id)).toBe(true);
    expect(await db.manager.count(SalePaymentEntity)).toBe(1);
    expect(await db.manager.count(InventoryMovementEntity)).toBe(1);
  });
  it('ventas concurrentes sin pérdida de saldo ni conflictos por versión', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => push(sale())),
    );
    expect(results.every((r) => r.status === 'accepted')).toBe(true);
    expect(
      (
        await db.manager.findOneByOrFail(InventoryBalanceEntity, {
          inventoryItemId: itemId,
        })
      ).quantityOnHandAtomic,
    ).toBe('-12');
    expect(await db.manager.count(SalePaymentEntity)).toBe(12);
  });
  it('dos confirmaciones concurrentes del mismo sale_id cobran una vez', async () => {
    const a = sale(),
      b = { ...sale(), aggregate_id: a.aggregate_id };
    expect(
      (await Promise.all([push(a), push(b)])).map((r) => r.status).sort(),
    ).toEqual(['accepted', 'conflict']);
    expect(await db.manager.count(InventoryMovementEntity)).toBe(1);
  });
  it('rollback de evento, refs, venta, pago y saldo ante fallo intermedio', async () => {
    const e = sale();
    const spy = jest
      .spyOn(
        handler as unknown as { saveRefs: () => Promise<void> },
        'saveRefs',
      )
      .mockRejectedValueOnce(new Error('injected'));
    await expect(push(e)).rejects.toThrow('injected');
    spy.mockRestore();
    expect(
      await db.manager.findOneBy(EventEntity, { eventId: e.event_id }),
    ).toBeNull();
    expect(await db.manager.count(SaleEntity)).toBe(0);
    expect(await db.manager.count(SaleItemEntity)).toBe(0);
    expect(await db.manager.count(SalePaymentEntity)).toBe(0);
    expect(await db.manager.count(InventoryMovementEntity)).toBe(0);
    expect(
      (
        await db.manager.findOneByOrFail(InventoryBalanceEntity, {
          inventoryItemId: itemId,
        })
      ).quantityOnHandAtomic,
    ).toBe('0');
  });
  it('acepta historia cobrada tras cambio de precio, receta y desactivación', async () => {
    const e = sale();
    await db.manager.update(
      ProductVariantEntity,
      { id: variantId },
      { active: false, salePriceMinor: '999', inventoryItemId: null },
    );
    await db.manager.update(
      ProductEntity,
      { id: productId },
      { active: false },
    );
    await db.manager.update(
      InventoryItemEntity,
      { id: itemId },
      { active: false },
    );
    expect((await push(e)).status).toBe('accepted');
    expect(
      (await db.manager.findOneByOrFail(SaleEntity, { id: e.aggregate_id }))
        .totalMinor,
    ).toBe('10000');
  });
  it('rechaza manipulación del total/delta y conserva resultado original en duplicados', async () => {
    const e = sale();
    e.payload.total_minor = 2;
    expect((await push(e)).status).toBe('rejected');
    expect((await push(e)).original_sync_status).toBe('rejected');
    const wrong = sale();
    const p = VentaConfirmadaPayload.fromJson(wrong.payload);
    p.lines[0].consumptions[0].component_atomic = 8;
    p.lines[0].consumptions[0].quantity_delta_atomic = -8;
    wrong.payload = p.toJson();
    expect((await push(wrong)).status).toBe('rejected');
    expect(await db.manager.count(SaleEntity)).toBe(0);
  });
  it('dependencia ausente queda en incidencia sin crear proyecciones', async () => {
    const e = sale();
    e.payload.dependency_event_ids = [configId, randomUUID()];
    expect((await push(e)).status).toBe('conflict');
    expect(await db.manager.count(SaleEntity)).toBe(0);
  });
  it('no permite doble movimiento ni pago con IDs reutilizados', async () => {
    const e = sale();
    expect((await push(e)).status).toBe('accepted');
    const other = sale();
    other.payload.payment_id = e.payload.payment_id;
    expect((await push(other)).status).toBe('conflict');
    expect(await db.manager.count(SaleEntity)).toBe(1);
  });
});

describe('aritmética compartida', () => {
  it('redondea half-up una vez y limita el resultado', () => {
    expect(rounded(1, 1, 2)).toBe(1);
    expect(rounded(1, 1, 3)).toBe(0);
    expect(rounded(Number.MAX_SAFE_INTEGER, 1, 1)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => rounded(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow();
  });
});
