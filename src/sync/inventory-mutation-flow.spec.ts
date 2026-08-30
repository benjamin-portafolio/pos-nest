import type { EntityManager, EntityTarget } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import type { PushEventDto } from './dto/push-events.dto';
import { InventoryEventHandler } from './inventory-event.handler';
import type { SyncConflictService } from './sync-conflict.service';

describe('InventoryEventHandler mutations', () => {
  it('actualiza nombre y después aplica reposición transaccional sin cambiar unidad', async () => {
    const fixture = mutationManagerFixture();
    const handler = new InventoryEventHandler(
      {} as unknown as SyncConflictService,
    );

    const update = await handler.apply(fixture.manager, updateEvent());
    const receipt = await handler.apply(fixture.manager, receiptEvent());

    expect(update.status).toBe('accepted');
    expect(receipt.status).toBe('accepted');
    expect(fixture.item.name).toBe('Harina integral');
    expect(fixture.item.defaultUnitId).toBe(
      '10000000-0000-4000-8000-000000000003',
    );
    expect(fixture.item.version).toBe(3);
    expect(fixture.balance.quantityOnHandAtomic).toBe('350');
    expect(fixture.balance.quantityAvailableAtomic).toBe('350');
    expect(fixture.balance.version).toBe(2);
    expect(fixture.valueFor(InventoryMovementEntity)).toEqual(
      expect.objectContaining({
        movementType: 'stock_receipt',
        quantityDeltaAtomic: '100',
        reason: null,
        reversalOfMovementId: null,
        totalCostMinor: null,
      }),
    );
    expect(fixture.valuesFor(EventRefEntity)).toHaveLength(3);
  });

  it('convierte una base obsoleta en conflicto optimista', async () => {
    const fixture = mutationManagerFixture();
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '90000000-0000-4000-8000-000000000001',
    });
    const handler = new InventoryEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);
    const stale = receiptEvent();
    stale.base_version = 1;

    const result = await handler.apply(fixture.manager, stale);

    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('no coincide');
    expect(fixture.balance.quantityOnHandAtomic).toBe('250');
    expect(fixture.valuesFor(InventoryMovementEntity)).toHaveLength(0);
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'concurrent_inventory_movement',
      }),
    );
  });
});

function mutationManagerFixture() {
  const item = Object.assign(new InventoryItemEntity(), {
    id: '20000000-0000-4000-8000-000000000001',
    defaultUnitId: '10000000-0000-4000-8000-000000000003',
    name: 'Harina',
    active: true,
    version: 1,
    createdEventId: '40000000-0000-4000-8000-000000000001',
    lastEventId: '40000000-0000-4000-8000-000000000001',
    lastServerSequence: '10',
  });
  const balance = Object.assign(new InventoryBalanceEntity(), {
    inventoryItemId: item.id,
    quantityOnHandAtomic: '250',
    quantityAvailableAtomic: '250',
    version: 1,
    lastEventId: item.lastEventId,
    lastServerSequence: '10',
  });
  const created: Array<{
    target: EntityTarget<unknown>;
    value: Record<string, unknown>;
  }> = [];
  let serverSequence = 10;
  const manager = {
    findOne: jest.fn((target: EntityTarget<unknown>) => {
      if (target === InventoryItemEntity) return Promise.resolve(item);
      if (target === InventoryBalanceEntity) return Promise.resolve(balance);
      if (target === InventoryMovementEntity) return Promise.resolve(null);
      return Promise.resolve(null);
    }),
    findOneBy: jest.fn(() => Promise.resolve(null)),
    create: jest.fn(
      (target: EntityTarget<unknown>, value: Record<string, unknown>) => {
        const entity = { ...value };
        if (target === EventEntity) {
          serverSequence += 1;
          entity.serverSequence = String(serverSequence);
          entity.createdAtServer = new Date('2026-08-29T12:00:00.000Z');
        }
        created.push({ target, value: entity });
        return entity;
      },
    ),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  } as unknown as EntityManager;

  return {
    manager,
    item,
    balance,
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

function updateEvent(): PushEventDto {
  return {
    event_id: '40000000-0000-4000-8000-000000000002',
    aggregate_type: 'inventory_item',
    aggregate_id: '20000000-0000-4000-8000-000000000001',
    event_type: 'recurso_inventario_actualizado',
    device_id: 'device-test',
    user_id: 'user-test',
    local_sequence: 2,
    base_server_sequence: 10,
    base_version: 1,
    created_at_local: '2026-08-29T11:00:00.000Z',
    payload: {
      base_event_id: '40000000-0000-4000-8000-000000000001',
      changed_fields: ['name'],
      changes: { name: { from: 'Harina', to: 'Harina integral' } },
    },
  };
}

function receiptEvent(): PushEventDto {
  return {
    event_id: '40000000-0000-4000-8000-000000000003',
    aggregate_type: 'inventory_item',
    aggregate_id: '20000000-0000-4000-8000-000000000001',
    event_type: 'movimiento_inventario_registrado',
    device_id: 'device-test',
    user_id: 'user-test',
    local_sequence: 3,
    base_server_sequence: 11,
    base_version: 2,
    created_at_local: '2026-08-29T11:01:00.000Z',
    payload: {
      base_event_id: '40000000-0000-4000-8000-000000000002',
      movement: {
        movement_id: '30000000-0000-4000-8000-000000000002',
        movement_type: 'stock_receipt',
        quantity_delta_atomic: 100,
        reason: null,
        reversal_of_movement_id: null,
        total_cost_minor: null,
      },
    },
  };
}
