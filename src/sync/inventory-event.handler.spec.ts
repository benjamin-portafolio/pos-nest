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
  it('registra alta y ajustes de recursos de inventario', () => {
    const handler = new InventoryEventHandler(
      {} as unknown as SyncConflictService,
    );
    expect(handler.supports('recurso_inventario_creado')).toBe(true);
    expect(handler.supports('existencia_inventario_ajustada')).toBe(true);
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

  it('aplica un ajuste y actualiza saldo, versión, movimiento y referencias', async () => {
    const fixture = adjustmentManagerFixture();
    const handler = new InventoryEventHandler(fixture.conflictService);

    const result = await handler.apply(
      fixture.manager,
      inventoryAdjustmentEvent(-25),
    );

    expect(result.status).toBe('accepted');
    expect(fixture.item.version).toBe(2);
    expect(fixture.item.lastEventId).toBe(
      '40000000-0000-4000-8000-000000000002',
    );
    expect(fixture.balance.quantityOnHandAtomic).toBe('75');
    expect(fixture.balance.quantityAvailableAtomic).toBe('75');
    expect(fixture.valueFor(InventoryMovementEntity)).toEqual(
      expect.objectContaining({
        movementId: '30000000-0000-4000-8000-000000000002',
        quantityDeltaAtomic: '-25',
        reason: 'Merma por rotura',
      }),
    );
    expect(
      fixture.valuesFor(EventRefEntity).map((value) => value.refType),
    ).toEqual(['inventory_item', 'inventory_movement']);
  });

  it('acepta un ajuste aditivo con base anterior y conserva los demás movimientos', async () => {
    const fixture = adjustmentManagerFixture({
      item: inventoryItem({ version: 4 }),
      balance: inventoryBalance({
        quantityOnHandAtomic: '300',
        quantityAvailableAtomic: '275',
      }),
    });
    const handler = new InventoryEventHandler(fixture.conflictService);

    const result = await handler.apply(
      fixture.manager,
      inventoryAdjustmentEvent(50, { baseVersion: 1 }),
    );

    expect(result.status).toBe('accepted');
    expect(fixture.item.version).toBe(5);
    expect(fixture.balance.quantityOnHandAtomic).toBe('350');
    expect(fixture.balance.quantityAvailableAtomic).toBe('325');
  });

  it('convierte recurso ausente y movement_id duplicado en conflictos funcionales', async () => {
    const missingFixture = adjustmentManagerFixture({ item: null });
    const missingHandler = new InventoryEventHandler(
      missingFixture.conflictService,
    );
    const missing = await missingHandler.apply(
      missingFixture.manager,
      inventoryAdjustmentEvent(10),
    );
    expect(missing.status).toBe('conflict');
    expect(missingFixture.recordConflict).toHaveBeenCalledWith(
      missingFixture.manager,
      expect.objectContaining({ conflictType: 'missing_inventory_item' }),
    );

    const collisionFixture = adjustmentManagerFixture({
      movement: Object.assign(new InventoryMovementEntity(), {
        movementId: '30000000-0000-4000-8000-000000000002',
        eventId: '40000000-0000-4000-8000-000000000099',
      }),
    });
    const collisionHandler = new InventoryEventHandler(
      collisionFixture.conflictService,
    );
    const collision = await collisionHandler.apply(
      collisionFixture.manager,
      inventoryAdjustmentEvent(10),
    );
    expect(collision.status).toBe('conflict');
    expect(collisionFixture.recordConflict).toHaveBeenCalledWith(
      collisionFixture.manager,
      expect.objectContaining({ conflictType: 'inventory_movement_conflict' }),
    );
  });

  it('rechaza el ajuste sin mutar el saldo cuando rebasa el entero seguro', async () => {
    const fixture = adjustmentManagerFixture({
      balance: inventoryBalance({
        quantityOnHandAtomic: String(Number.MAX_SAFE_INTEGER),
        quantityAvailableAtomic: String(Number.MAX_SAFE_INTEGER),
      }),
    });
    const handler = new InventoryEventHandler(fixture.conflictService);

    const result = await handler.apply(
      fixture.manager,
      inventoryAdjustmentEvent(1),
    );

    expect(result.status).toBe('rejected');
    expect(fixture.balance.quantityOnHandAtomic).toBe(
      String(Number.MAX_SAFE_INTEGER),
    );
    expect(fixture.valuesFor(InventoryMovementEntity)).toHaveLength(0);
  });

  it('reaplicar el mismo ajuste no vuelve a sumar el saldo', async () => {
    const event = inventoryAdjustmentEvent(10);
    const fixture = adjustmentManagerFixture({
      movement: Object.assign(new InventoryMovementEntity(), {
        movementId: '30000000-0000-4000-8000-000000000002',
        eventId: event.event_id,
      }),
      existingEvent: Object.assign(new EventEntity(), {
        eventId: event.event_id,
        serverSequence: '12',
        createdAtServer: new Date('2026-08-19T12:05:00.000Z'),
      }),
    });
    const handler = new InventoryEventHandler(fixture.conflictService);

    const result = await handler.apply(fixture.manager, event);

    expect(result.status).toBe('accepted');
    expect(fixture.balance.quantityOnHandAtomic).toBe('100');
    expect(fixture.item.version).toBe(1);
    expect(fixture.valuesFor(InventoryMovementEntity)).toHaveLength(0);
    expect(fixture.valuesFor(EventRefEntity)).toHaveLength(0);
  });
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

function adjustmentManagerFixture(
  options: {
    item?: InventoryItemEntity | null;
    balance?: InventoryBalanceEntity | null;
    movement?: InventoryMovementEntity | null;
    existingEvent?: EventEntity | null;
  } = {},
) {
  const created: Array<{
    target: EntityTarget<unknown>;
    value: Record<string, unknown>;
  }> = [];
  const item = Object.prototype.hasOwnProperty.call(options, 'item')
    ? (options.item ?? null)
    : inventoryItem();
  const balance = Object.prototype.hasOwnProperty.call(options, 'balance')
    ? (options.balance ?? null)
    : inventoryBalance();
  const movement = options.movement ?? null;
  const existingEvent = options.existingEvent ?? null;
  const recordConflict = jest.fn().mockResolvedValue({
    conflictId: '90000000-0000-4000-8000-000000000001',
  });
  const conflictService = {
    recordConflict,
  } as unknown as jest.Mocked<SyncConflictService>;
  const manager = {
    findOne: jest.fn((target: EntityTarget<unknown>) => {
      if (target === InventoryItemEntity) return Promise.resolve(item);
      if (target === InventoryMovementEntity) return Promise.resolve(movement);
      if (target === InventoryBalanceEntity) return Promise.resolve(balance);
      return Promise.resolve(null);
    }),
    findOneBy: jest.fn((target: EntityTarget<unknown>) =>
      Promise.resolve(target === EventEntity ? existingEvent : null),
    ),
    create: jest.fn(
      (target: EntityTarget<unknown>, value: Record<string, unknown>) => {
        const entity = { ...value };
        if (target === EventEntity) {
          entity.serverSequence = '12';
          entity.createdAtServer = new Date('2026-08-19T12:05:00.000Z');
        }
        created.push({ target, value: entity });
        return entity;
      },
    ),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  } as unknown as EntityManager;

  return {
    manager,
    conflictService,
    recordConflict,
    item: item!,
    balance: balance!,
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

function inventoryItem(
  overrides: Partial<InventoryItemEntity> = {},
): InventoryItemEntity {
  return Object.assign(new InventoryItemEntity(), {
    id: '20000000-0000-4000-8000-000000000001',
    defaultUnitId: '10000000-0000-4000-8000-000000000003',
    name: 'Harina',
    active: true,
    version: 1,
    createdEventId: '40000000-0000-4000-8000-000000000001',
    lastEventId: '40000000-0000-4000-8000-000000000001',
    lastServerSequence: '11',
    ...overrides,
  });
}

function inventoryBalance(
  overrides: Partial<InventoryBalanceEntity> = {},
): InventoryBalanceEntity {
  return Object.assign(new InventoryBalanceEntity(), {
    inventoryItemId: '20000000-0000-4000-8000-000000000001',
    quantityOnHandAtomic: '100',
    quantityAvailableAtomic: '100',
    lastEventId: '40000000-0000-4000-8000-000000000001',
    lastServerSequence: '11',
    ...overrides,
  });
}

function inventoryAdjustmentEvent(
  delta: number,
  options: { baseVersion?: number } = {},
): PushEventDto {
  return {
    event_id: '40000000-0000-4000-8000-000000000002',
    aggregate_type: 'inventory_item',
    aggregate_id: '20000000-0000-4000-8000-000000000001',
    event_type: 'existencia_inventario_ajustada',
    device_id: 'device-test',
    user_id: 'user-test',
    local_sequence: 2,
    base_server_sequence: null,
    base_version: options.baseVersion ?? 1,
    created_at_local: '2026-08-19T11:05:00.000Z',
    payload: {
      inventory_item_id: '20000000-0000-4000-8000-000000000001',
      movement: {
        movement_id: '30000000-0000-4000-8000-000000000002',
        movement_type: 'manual_adjustment',
        quantity_delta_atomic: delta,
        reason: 'Merma por rotura',
      },
    },
  };
}
