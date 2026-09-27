import type { EntityManager, EntityTarget } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { FinancialCategoryEntity } from '../entities/financial-category.entity';
import { FinancialEntryEntity } from '../entities/financial-entry.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { readFinancialFixture } from '../testing/financial-fixtures';
import type { PushEventDto } from './dto/push-events.dto';
import { FinancialEntryEventHandler } from './financial-entry-event.handler';
import type { SyncConflictService } from './sync-conflict.service';

const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ENTRY_EVENT_ID = '44444444-4444-4444-8444-444444444444';

describe('FinancialEntryEventHandler', () => {
  it('registra únicamente movimiento_financiero_registrado', () => {
    const handler = new FinancialEntryEventHandler(
      {} as unknown as SyncConflictService,
    );
    expect(handler.supports('movimiento_financiero_registrado')).toBe(true);
    expect(handler.supports('categoria_financiera_creada')).toBe(false);
    expect(handler.supports('otro_evento')).toBe(false);
  });

  it.each([
    ['sobre-base-version-invalid.json'],
    ['sobre-base-server-sequence-invalid.json'],
    ['sobre-aggregate-type-invalid.json'],
  ])('rechaza el sobre %s sin guardar evento', async (file) => {
    const fixture = managerFixture();
    const handler = new FinancialEntryEventHandler(fixture.conflicts);
    const result = await handler.apply(
      fixture.manager,
      sobre(`registro/${file}`),
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('Sobre de registro financiero inválido.');
    expect(fixture.valuesFor(EventEntity)).toHaveLength(0);
  });

  it('rechaza payload inválido sin guardar evento', async () => {
    const fixture = managerFixture();
    const handler = new FinancialEntryEventHandler(fixture.conflicts);
    const e = sobre('registro/sobre-entry-cash-valid.json');
    e.payload.amount_minor = 0;

    const result = await handler.apply(fixture.manager, e);

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe(
      'amount_minor debe ser un entero positivo en centavos.',
    );
    expect(fixture.valuesFor(EventEntity)).toHaveLength(0);
  });

  it('devuelve duplicate preservando el estado original', async () => {
    const fixture = managerFixture({
      duplicate: eventRecord({
        eventId: ENTRY_EVENT_ID,
        syncStatus: EventSyncStatus.SYNCED,
      }),
    });
    const handler = new FinancialEntryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('registro/sobre-entry-cash-valid.json'),
    );

    expect(result.status).toBe('duplicate');
    expect(result.original_sync_status).toBe(EventSyncStatus.SYNCED);
    expect(fixture.valuesFor(EventEntity)).toHaveLength(0);
  });

  it('colisión de identidad: conflicto sin ganador y sin sobrescribir', async () => {
    const fixture = managerFixture({ entryExists: true });
    const handler = new FinancialEntryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('registro/sobre-entry-cash-valid.json'),
    );

    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'Identidad de registro financiero ya registrada.',
    });
    expect(fixture.recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'financial_entry_identity',
        refType: 'financial_category',
        refId: CATEGORY_ID,
        defaultWinnerEventId: null,
      }),
    );
    expect(fixture.valuesFor(FinancialEntryEntity)).toHaveLength(0);
  });

  it.each([
    [
      'sin categoría ni evento',
      {} as never,
      {} as never,
      'financial_entry_dependency',
    ],
  ])('dependencia inexistente produce conflicto (%s)', async () => {
    const fixture = managerFixture();
    const handler = new FinancialEntryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('registro/sobre-entry-cash-valid.json'),
    );

    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'La categoría del registro no está disponible en el servidor.',
    });
    expect(fixture.recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'financial_entry_dependency',
      }),
    );
    expect(fixture.valuesFor(FinancialEntryEntity)).toHaveLength(0);
    expect(fixture.valuesFor(EventEntity)[0].syncStatus).toBe('conflict');
  });

  it('categoría con created_event_id distinto del payload no es oficial', async () => {
    const fixture = managerFixture({
      categories: {
        [CATEGORY_ID]: category({
          createdEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        }),
      },
      events: { [CATEGORY_EVENT_ID]: syncedEvent() },
    });
    const handler = new FinancialEntryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('registro/sobre-entry-cash-valid.json'),
    );

    expect(result.reason).toBe(
      'La categoría del registro no está disponible en el servidor.',
    );
    expect(fixture.recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'financial_entry_dependency',
        defaultWinnerEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    );
  });

  it('evento de creación no sincronizado no habilita la categoría', async () => {
    const fixture = managerFixture({
      categories: { [CATEGORY_ID]: category() },
      events: {
        [CATEGORY_EVENT_ID]: eventRecord({
          eventId: CATEGORY_EVENT_ID,
          syncStatus: EventSyncStatus.PENDING,
        }),
      },
    });
    const handler = new FinancialEntryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('registro/sobre-entry-cash-valid.json'),
    );

    expect(result.reason).toBe(
      'La categoría del registro no está disponible en el servidor.',
    );
  });

  it('snapshot de dirección distinto a la categoría es un conflicto de clasificación', async () => {
    const fixture = managerFixture({
      categories: {
        [CATEGORY_ID]: category({ direction: 'in' }),
      },
      events: { [CATEGORY_EVENT_ID]: syncedEvent() },
    });
    const handler = new FinancialEntryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('registro/sobre-entry-cash-valid.json'),
    );

    expect(result).toMatchObject({
      status: 'conflict',
      reason:
        'La clasificación del registro no coincide con la categoría oficial.',
    });
    expect(fixture.recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'financial_entry_snapshot',
        defaultWinnerEventId: CATEGORY_EVENT_ID,
      }),
    );
    expect(fixture.valuesFor(FinancialEntryEntity)).toHaveLength(0);
  });

  it('acepta el registro: evento synced, proyección y refs affects/uses', async () => {
    const fixture = managerFixture({
      categories: { [CATEGORY_ID]: category() },
      events: { [CATEGORY_EVENT_ID]: syncedEvent() },
    });
    const handler = new FinancialEntryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('registro/sobre-entry-cash-valid.json'),
    );

    expect(result.status).toBe('accepted');
    expect(fixture.valuesFor(EventEntity)[0]).toEqual(
      expect.objectContaining({
        eventId: ENTRY_EVENT_ID,
        aggregateType: 'financial_entry',
        aggregateId: '33333333-3333-4333-8333-333333333333',
        eventType: 'movimiento_financiero_registrado',
        syncStatus: EventSyncStatus.SYNCED,
      }),
    );
    expect(fixture.valuesFor(FinancialEntryEntity)[0]).toEqual(
      expect.objectContaining({
        id: '33333333-3333-4333-8333-333333333333',
        categoryId: CATEGORY_ID,
        categoryNameSnapshot: 'Renta',
        direction: 'out',
        nature: 'operating',
        amountMinor: '50000',
        currency: 'MXN',
        method: 'cash',
        occurredAtMs: '1789041600000',
        notes: 'Renta en efectivo',
        reference: null,
        version: 1,
        createdEventId: ENTRY_EVENT_ID,
        lastEventId: ENTRY_EVENT_ID,
        lastServerSequence: '11',
      }),
    );
    const refs = fixture.valuesFor(EventRefEntity);
    expect(refs).toHaveLength(2);
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refType: 'financial_entry',
          refId: '33333333-3333-4333-8333-333333333333',
          relationship: 'affects',
          source: 'server',
        }),
        expect.objectContaining({
          refType: 'financial_category',
          refId: CATEGORY_ID,
          relationship: 'uses',
          source: 'server',
        }),
      ]),
    );
    expect(fixture.recordConflict).not.toHaveBeenCalled();
  });

  it('carrera 23505 resuelve como conflicto controlado sin 500', async () => {
    const fixture = managerFixture();
    const handler = new FinancialEntryEventHandler(fixture.conflicts);

    const result = await handler.saveUniqueViolationConflict(
      fixture.manager,
      sobre('registro/sobre-entry-cash-valid.json'),
    );

    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'Identidad de registro financiero ya registrada.',
      conflict_id: 'conflict-1',
    });
    expect(fixture.recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'financial_entry_identity',
        defaultWinnerEventId: null,
      }),
    );
  });
});

function managerFixture(
  options: {
    duplicate?: EventEntity | null;
    entryExists?: boolean;
    categories?: Record<string, FinancialCategoryEntity | null>;
    events?: Record<string, EventEntity | null>;
  } = {},
) {
  const created: Array<{
    target: EntityTarget<unknown>;
    value: Record<string, unknown>;
  }> = [];
  const recordConflict = jest
    .fn()
    .mockResolvedValue({ conflictId: 'conflict-1' });
  const duplicate = options.duplicate ?? null;
  const entryExists = options.entryExists ?? false;
  const categories = options.categories ?? {};
  const events = options.events ?? {};
  const manager = {
    findOneBy: jest.fn(
      (target: EntityTarget<unknown>, criteria: Record<string, unknown>) => {
        if (target === EventEntity && criteria.eventId) {
          if (duplicate && criteria.eventId === duplicate.eventId) {
            return Promise.resolve(duplicate);
          }
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(events, criteria.eventId)
              ? events[criteria.eventId]
              : null,
          );
        }
        if (target === FinancialCategoryEntity && criteria.id) {
          return Promise.resolve(
            Object.prototype.hasOwnProperty.call(categories, criteria.id)
              ? categories[criteria.id]
              : null,
          );
        }
        return Promise.resolve(null);
      },
    ),
    existsBy: jest.fn((target: EntityTarget<unknown>) => {
      if (target === FinancialEntryEntity) return Promise.resolve(entryExists);
      return Promise.resolve(false);
    }),
    create: jest.fn(
      (target: EntityTarget<unknown>, value: Record<string, unknown>) => {
        const entity = { ...value };
        if (target === EventEntity) {
          entity.serverSequence = '11';
          entity.createdAtServer = new Date('2026-09-24T14:38:05.000Z');
        }
        created.push({ target, value: entity });
        return entity;
      },
    ),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
    insert: jest.fn((target: EntityTarget<unknown>, value: unknown) => {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        created.push({ target, value: item as Record<string, unknown> });
      }
      return Promise.resolve({});
    }),
  } as unknown as EntityManager;

  return {
    manager,
    recordConflict,
    conflicts: { recordConflict } as unknown as SyncConflictService,
    valuesFor(target: EntityTarget<unknown>) {
      return created
        .filter((entry) => entry.target === target)
        .map((entry) => entry.value);
    },
  };
}

function sobre(file: string): PushEventDto {
  return readFinancialFixture(file) as unknown as PushEventDto;
}

function category(
  overrides: Partial<FinancialCategoryEntity>,
): FinancialCategoryEntity {
  return Object.assign(new FinancialCategoryEntity(), {
    id: CATEGORY_ID,
    name: 'Renta',
    direction: 'out',
    nature: 'operating',
    active: true,
    version: 1,
    createdEventId: CATEGORY_EVENT_ID,
    lastEventId: CATEGORY_EVENT_ID,
    lastServerSequence: '10',
    ...overrides,
  });
}

function syncedEvent(): EventEntity {
  return eventRecord({
    eventId: CATEGORY_EVENT_ID,
    syncStatus: EventSyncStatus.SYNCED,
  });
}

function eventRecord({
  eventId,
  syncStatus,
}: {
  eventId: string;
  syncStatus: EventSyncStatus;
}): EventEntity {
  return {
    eventId,
    aggregateType: 'financial_category',
    aggregateId: CATEGORY_ID,
    eventType: 'categoria_financiera_creada',
    deviceId: 'dispositivo-1',
    userId: 'usuario-1',
    localSequence: 1,
    serverSequence: '10',
    baseServerSequence: null,
    baseVersion: 1,
    createdAtLocal: new Date('2026-09-24T12:00:00.000Z'),
    createdAtServer: new Date('2026-09-24T14:38:05.000Z'),
    payload: {},
    syncStatus,
    rejectionReason: null,
    updatedAtServer: new Date('2026-09-24T14:38:05.000Z'),
  };
}
