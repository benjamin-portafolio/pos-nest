import { CategoryEntity } from '../entities/category.entity';
import { ProductEntity } from '../entities/product.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { SaleEntity } from '../entities/sale.entity';
import { SaleItemEntity } from '../entities/sale-item.entity';
import { DataSource } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { UnitEntity } from '../entities/unit.entity';
import { INVENTORY_UNIT_SEED } from '../inventory/inventory-unit-seed';
import type { PushEventDto } from './dto/push-events.dto';
import { InventoryEventHandler } from './inventory-event.handler';
import type { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';
import type { EventsGateway } from '../events/events.gateway';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration('InventoryEventHandler con PostgreSQL real', () => {
  jest.setTimeout(30_000);

  const schema = `inventory_it_${process.pid}_${Date.now()}`;
  let administration: DataSource;
  let database: DataSource;
  const handler = new InventoryEventHandler({
    recordConflict: jest.fn().mockResolvedValue({
      conflictId: '90000000-0000-4000-8000-000000000001',
    }),
  } as unknown as SyncConflictService);

  beforeAll(async () => {
    const connection = postgresConnectionOptions();
    administration = new DataSource(connection);
    await administration.initialize();
    await administration.query(`CREATE SCHEMA "${schema}"`);
    database = new DataSource({
      ...connection,
      schema,
      entities: [
        SaleEntity,
        SaleItemEntity,
        SalePaymentEntity,
        ProductVariantEntity,
        ProductEntity,
        CategoryEntity,
        EventEntity,
        EventRefEntity,
        UnitEntity,
        InventoryItemEntity,
        InventoryBalanceEntity,
        InventoryMovementEntity,
      ],
      synchronize: true,
    });
    await database.initialize();
    await database.manager.save(
      INVENTORY_UNIT_SEED.map((value) =>
        database.manager.create(UnitEntity, {
          ...value,
          atomicFactor: String(value.atomicFactor),
          active: true,
        }),
      ),
    );
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (administration?.isInitialized) {
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.destroy();
    }
  });

  beforeEach(async () => {
    await database.query(`
      TRUNCATE TABLE
        "${schema}"."inventory_movements",
        "${schema}"."inventory_balances",
        "${schema}"."inventory_items",
        "${schema}"."event_refs",
        "${schema}"."events"
      RESTART IDENTITY CASCADE
    `);
  });

  it.each([250, -250])(
    'aplica atómicamente un movimiento inicial %s',
    async (delta) => {
      const result = await database.transaction((manager) =>
        handler.apply(manager, inventoryEvent({ delta })),
      );

      expect(result.status).toBe('accepted');
      expect(await database.manager.count(InventoryItemEntity)).toBe(1);
      expect(await database.manager.count(InventoryMovementEntity)).toBe(1);
      const balance = await database.manager.findOneByOrFail(
        InventoryBalanceEntity,
        { inventoryItemId: '20000000-0000-4000-8000-000000000001' },
      );
      expect(balance.quantityOnHandAtomic).toBe(String(delta));
      expect(balance.quantityAvailableAtomic).toBe(String(delta));
      expect(await database.manager.count(EventRefEntity)).toBe(3);
    },
  );

  it('sin movimiento crea balance cero y ninguna cantidad cero', async () => {
    await database.transaction((manager) =>
      handler.apply(manager, inventoryEvent({ delta: null })),
    );
    expect(await database.manager.count(InventoryMovementEntity)).toBe(0);
    const balance = await database.manager.findOneByOrFail(
      InventoryBalanceEntity,
      { inventoryItemId: '20000000-0000-4000-8000-000000000001' },
    );
    expect(balance.quantityOnHandAtomic).toBe('0');
  });

  it('sincroniza push/pull entre dispositivos sin duplicar el movimiento', async () => {
    const notifyEventsAvailable = jest.fn();
    const service = new SyncService(
      database,
      { notifyEventsAvailable } as unknown as EventsGateway,
      {} as SyncConflictService,
      undefined,
      undefined,
      handler,
    );
    const event = inventoryEvent({ delta: 375 });

    const firstPush = await service.pushEvents({
      device_id: event.device_id,
      events: [event],
    });
    const duplicatePush = await service.pushEvents({
      device_id: event.device_id,
      events: [event],
    });
    const pullForSecondDevice = await service.pullEvents({ since: 0 });

    expect(firstPush.results[0]?.status).toBe('accepted');
    expect(duplicatePush.results[0]?.status).toBe('duplicate');
    expect(pullForSecondDevice.events).toHaveLength(1);
    expect(pullForSecondDevice.events[0]).toEqual(
      expect.objectContaining({
        event_id: event.event_id,
        event_type: 'recurso_inventario_creado',
        sync_status: 'synced',
      }),
    );
    expect(await database.manager.count(InventoryMovementEntity)).toBe(1);
    expect(
      (
        await database.manager.findOneByOrFail(InventoryBalanceEntity, {
          inventoryItemId: event.aggregate_id,
        })
      ).quantityOnHandAtomic,
    ).toBe('375');
    expect(notifyEventsAvailable).toHaveBeenCalledTimes(1);
  });

  it('convierte un movement_id duplicado en conflicto funcional', async () => {
    const first = inventoryEvent({ delta: 250 });
    await database.transaction((manager) => handler.apply(manager, first));

    const colliding = inventoryEvent({
      delta: -100,
      eventId: '40000000-0000-4000-8000-000000000002',
      itemId: '20000000-0000-4000-8000-000000000002',
      movementId: '30000000-0000-4000-8000-000000000001',
      localSequence: 2,
    });
    const result = await database.transaction((manager) =>
      handler.apply(manager, colliding),
    );

    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('Ya existe un movimiento');
    expect(await database.manager.count(InventoryItemEntity)).toBe(1);
    expect(await database.manager.count(InventoryMovementEntity)).toBe(1);
    expect(
      (
        await database.manager.findOneByOrFail(InventoryBalanceEntity, {
          inventoryItemId: first.aggregate_id,
        })
      ).quantityOnHandAtomic,
    ).toBe('250');
  });

  it('revierte evento, refs, recurso y balance ante fallo del movimiento', async () => {
    await database.query(`
      CREATE FUNCTION "${schema}".fail_inventory_movement()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced inventory movement failure';
      END;
      $$
    `);
    await database.query(`
      CREATE TRIGGER fail_inventory_movement
      BEFORE INSERT ON "${schema}"."inventory_movements"
      FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_inventory_movement()
    `);

    await expect(
      database.transaction((manager) =>
        handler.apply(manager, inventoryEvent({ delta: 250 })),
      ),
    ).rejects.toThrow('forced inventory movement failure');

    expect(await database.manager.count(EventEntity)).toBe(0);
    expect(await database.manager.count(EventRefEntity)).toBe(0);
    expect(await database.manager.count(InventoryItemEntity)).toBe(0);
    expect(await database.manager.count(InventoryBalanceEntity)).toBe(0);
    expect(await database.manager.count(InventoryMovementEntity)).toBe(0);

    await database.query(
      `DROP TRIGGER fail_inventory_movement ON "${schema}"."inventory_movements"`,
    );
    await database.query(`DROP FUNCTION "${schema}".fail_inventory_movement()`);
  });
});

function inventoryEvent({
  delta,
  eventId = '40000000-0000-4000-8000-000000000001',
  itemId = '20000000-0000-4000-8000-000000000001',
  movementId = '30000000-0000-4000-8000-000000000001',
  localSequence = 1,
}: {
  delta: number | null;
  eventId?: string;
  itemId?: string;
  movementId?: string;
  localSequence?: number;
}): PushEventDto {
  return {
    event_id: eventId,
    aggregate_type: 'inventory_item',
    aggregate_id: itemId,
    event_type: 'recurso_inventario_creado',
    device_id: 'postgres-inventory-device',
    user_id: 'postgres-inventory-user',
    local_sequence: localSequence,
    base_server_sequence: null,
    base_version: 1,
    created_at_local: '2026-08-19T11:00:00.000Z',
    payload: {
      inventory_item: {
        inventory_item_id: itemId,
        name: 'Harina',
        default_unit_id: '10000000-0000-4000-8000-000000000003',
      },
      initial_movement:
        delta === null
          ? null
          : {
              movement_id: movementId,
              movement_type: 'manual_adjustment',
              quantity_delta_atomic: delta,
              reason: 'Existencia inicial',
            },
    },
  };
}

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
