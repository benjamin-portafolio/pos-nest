import type { EntityManager, EntityTarget } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { UnitEntity } from '../entities/unit.entity';
import type { PushEventDto } from './dto/push-events.dto';
import { InventoryEventHandler } from './inventory-event.handler';
import type { SyncConflictService } from './sync-conflict.service';

describe('InventoryEventHandler', () => {
  it('registra solo recurso_inventario_creado', () => {
    const handler = new InventoryEventHandler(
      {} as unknown as SyncConflictService,
    );
    expect(handler.supports('recurso_inventario_creado')).toBe(true);
    expect(handler.supports('inventario_ajustado')).toBe(false);
  });

  it.each([250, -250])(
    'crea recurso, balance y movimiento con delta %s',
    async (delta) => {
      const fixture = managerFixture();
      const handler = new InventoryEventHandler(
        {} as unknown as SyncConflictService,
      );

      const result = await handler.apply(
        fixture.manager,
        inventoryEvent(delta),
      );

      expect(result.status).toBe('accepted');
      expect(fixture.valueFor(InventoryItemEntity)).toEqual(
        expect.objectContaining({
          name: 'Harina',
          defaultUnitId: '10000000-0000-4000-8000-000000000003',
        }),
      );
      expect(fixture.valueFor(InventoryMovementEntity)).toEqual(
        expect.objectContaining({ quantityDeltaAtomic: String(delta) }),
      );
      expect(fixture.balance.quantityOnHandAtomic).toBe(String(delta));
      expect(fixture.balance.quantityAvailableAtomic).toBe(String(delta));
      expect(
        fixture.valuesFor(EventRefEntity).map((value) => value.refType),
      ).toEqual(['inventory_item', 'unit', 'inventory_movement']);
    },
  );

  it('sin cantidad deja balance cero y no crea movimiento', async () => {
    const fixture = managerFixture();
    const handler = new InventoryEventHandler(
      {} as unknown as SyncConflictService,
    );
    const result = await handler.apply(fixture.manager, inventoryEvent(null));

    expect(result.status).toBe('accepted');
    expect(fixture.valuesFor(InventoryMovementEntity)).toHaveLength(0);
    expect(fixture.balance.quantityOnHandAtomic).toBe('0');
    expect(fixture.valuesFor(EventRefEntity)).toHaveLength(2);
  });

  it.each([
    [null, 'no existe'],
    [unit({ active: false }), 'inactiva'],
    [unit({ atomicFactor: '0' }), 'configuración'],
  ] as const)(
    'rechaza unidad inexistente, inactiva o inválida',
    async (selectedUnit, expectedReason) => {
      const fixture = managerFixture({ selectedUnit });
      const handler = new InventoryEventHandler(
        {} as unknown as SyncConflictService,
      );
      const result = await handler.apply(fixture.manager, inventoryEvent(null));

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain(expectedReason);
      expect(fixture.valuesFor(InventoryItemEntity)).toHaveLength(0);
      expect(fixture.valuesFor(InventoryBalanceEntity)).toHaveLength(0);
    },
  );
});

function managerFixture(options: { selectedUnit?: UnitEntity | null } = {}) {
  const created: Array<{
    target: EntityTarget<unknown>;
    value: Record<string, unknown>;
  }> = [];
  let balance: Record<string, unknown> | null = null;
  const selectedUnit = Object.prototype.hasOwnProperty.call(
    options,
    'selectedUnit',
  )
    ? (options.selectedUnit ?? null)
    : unit();
  const manager = {
    findOne: jest.fn((target: EntityTarget<unknown>) => {
      if (target === UnitEntity) return Promise.resolve(selectedUnit);
      return Promise.resolve(null);
    }),
    findOneOrFail: jest.fn(() => Promise.resolve(balance)),
    create: jest.fn(
      (target: EntityTarget<unknown>, value: Record<string, unknown>) => {
        const entity = { ...value };
        if (target === EventEntity) {
          entity.serverSequence = '11';
          entity.createdAtServer = new Date('2026-08-19T12:00:00.000Z');
        }
        if (target === InventoryBalanceEntity) balance = entity;
        created.push({ target, value: entity });
        return entity;
      },
    ),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    findOneBy: jest.fn(() => Promise.resolve(null)),
  } as unknown as EntityManager;

  return {
    manager,
    get balance() {
      return balance!;
    },
    valuesFor(target: EntityTarget<unknown>) {
      return created
        .filter((entry) => entry.target === target)
        .map((entry) => entry.value);
    },
    valueFor(target: EntityTarget<unknown>) {
      return created.find((entry) => entry.target === target)?.value;
    },
  };
}

function unit(overrides: Partial<UnitEntity> = {}): UnitEntity {
  return Object.assign(new UnitEntity(), {
    unitId: '10000000-0000-4000-8000-000000000003',
    code: 'kg',
    name: 'Kilogramo',
    symbol: 'kg',
    dimension: 'mass',
    atomicFactor: '1000',
    maxFractionDigits: 3,
    active: true,
    ...overrides,
  });
}

function inventoryEvent(delta: number | null): PushEventDto {
  return {
    event_id: '40000000-0000-4000-8000-000000000001',
    aggregate_type: 'inventory_item',
    aggregate_id: '20000000-0000-4000-8000-000000000001',
    event_type: 'recurso_inventario_creado',
    device_id: 'device-test',
    user_id: 'user-test',
    local_sequence: 1,
    base_server_sequence: null,
    base_version: 1,
    created_at_local: '2026-08-19T11:00:00.000Z',
    payload: {
      inventory_item: {
        inventory_item_id: '20000000-0000-4000-8000-000000000001',
        name: 'Harina',
        default_unit_id: '10000000-0000-4000-8000-000000000003',
      },
      initial_movement:
        delta === null
          ? null
          : {
              movement_id: '30000000-0000-4000-8000-000000000001',
              movement_type: 'manual_adjustment',
              quantity_delta_atomic: delta,
              reason: 'Existencia inicial',
            },
    },
  };
}
