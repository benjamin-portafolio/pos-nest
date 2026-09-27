import type { EntityManager, EntityTarget } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { FinancialCategoryEntity } from '../entities/financial-category.entity';
import { readFinancialFixture } from '../testing/financial-fixtures';
import type { PushEventDto } from './dto/push-events.dto';
import { FinancialCategoryEventHandler } from './financial-category-event.handler';
import type { SyncConflictService } from './sync-conflict.service';

describe('FinancialCategoryEventHandler', () => {
  it('registra únicamente categoria_financiera_creada', () => {
    const handler = new FinancialCategoryEventHandler(
      {} as unknown as SyncConflictService,
    );
    expect(handler.supports('categoria_financiera_creada')).toBe(true);
    expect(handler.supports('financial_category_updated')).toBe(false);
    expect(handler.supports('movimiento_financiero_registrado')).toBe(false);
  });

  it.each([
    ['sobre-base-version-invalid.json'],
    ['sobre-base-server-sequence-invalid.json'],
    ['sobre-aggregate-type-invalid.json'],
  ])('rechaza el sobre %s sin guardar evento', async (file) => {
    const fixture = managerFixture();
    const handler = new FinancialCategoryEventHandler(fixture.conflicts);
    const result = await handler.apply(
      fixture.manager,
      sobre(`categoria_financiera/${file}`),
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe('Sobre de categoría financiera inválido.');
    expect(fixture.valuesFor(EventEntity)).toHaveLength(0);
  });

  it('rechaza payload inválido sin guardar evento', async () => {
    const fixture = managerFixture();
    const handler = new FinancialCategoryEventHandler(fixture.conflicts);
    const e = sobre('categoria_financiera/sobre-renta-valid.json');
    e.payload.name = '';

    const result = await handler.apply(fixture.manager, e);

    expect(result.status).toBe('rejected');
    expect(result.reason).toBe(
      'El nombre de la categoría financiera es obligatorio.',
    );
    expect(fixture.valuesFor(EventEntity)).toHaveLength(0);
  });

  it('devuelve duplicate con estado original si el event_id ya existe', async () => {
    const fixture = managerFixture({
      duplicate: eventRecord({
        eventId: '22222222-2222-4222-8222-222222222222',
      }),
    });
    const handler = new FinancialCategoryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('categoria_financiera/sobre-renta-valid.json'),
    );

    expect(result.status).toBe('duplicate');
    expect(result.original_sync_status).toBe('synced');
    expect(fixture.valuesFor(EventEntity)).toHaveLength(0);
    expect(fixture.valuesFor(FinancialCategoryEntity)).toHaveLength(0);
  });

  it('colisión de identidad produce conflicto sin sobrescribir la fila', async () => {
    const fixture = managerFixture({
      existing: category({
        createdEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    });
    const handler = new FinancialCategoryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('categoria_financiera/sobre-renta-valid.json'),
    );

    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'Ya existe una categoría financiera con este id.',
    });
    expect(fixture.recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'financial_category_identity',
        refType: 'financial_category',
        refId: '11111111-1111-4111-8111-111111111111',
        defaultWinnerEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    );
    const event = fixture.valuesFor(EventEntity)[0];
    expect(event.syncStatus).toBe('conflict');
    expect(event.rejectionReason).toBe(
      'Ya existe una categoría financiera con este id.',
    );
    expect(fixture.valuesFor(FinancialCategoryEntity)).toHaveLength(0);
    expect(fixture.valuesFor(EventRefEntity)).toHaveLength(1);
  });

  it('acepta la categoría: evento synced, proyección y refs canónicas', async () => {
    const fixture = managerFixture();
    const handler = new FinancialCategoryEventHandler(fixture.conflicts);

    const result = await handler.apply(
      fixture.manager,
      sobre('categoria_financiera/sobre-renta-valid.json'),
    );

    expect(result.status).toBe('accepted');
    expect(fixture.valuesFor(EventEntity)[0]).toEqual(
      expect.objectContaining({
        eventId: '22222222-2222-4222-8222-222222222222',
        aggregateType: 'financial_category',
        aggregateId: '11111111-1111-4111-8111-111111111111',
        eventType: 'categoria_financiera_creada',
        syncStatus: 'synced',
      }),
    );
    expect(fixture.valuesFor(FinancialCategoryEntity)[0]).toEqual(
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Renta',
        direction: 'out',
        nature: 'operating',
        version: 1,
        createdEventId: '22222222-2222-4222-8222-222222222222',
        lastEventId: '22222222-2222-4222-8222-222222222222',
        lastServerSequence: '11',
      }),
    );
    expect(fixture.valuesFor(EventRefEntity)).toEqual([
      expect.objectContaining({
        eventId: '22222222-2222-4222-8222-222222222222',
        refType: 'financial_category',
        refId: '11111111-1111-4111-8111-111111111111',
        relationship: 'affects',
        source: 'server',
      }),
    ]);
    expect(fixture.recordConflict).not.toHaveBeenCalled();
  });

  it('carrera 23505 guarda conflicto controlado sin 500', async () => {
    const fixture = managerFixture({
      existing: category({
        createdEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    });
    const handler = new FinancialCategoryEventHandler(fixture.conflicts);

    const result = await handler.saveUniqueViolationConflict(
      fixture.manager,
      sobre('categoria_financiera/sobre-renta-valid.json'),
    );

    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'Identidad de categoría financiera ya registrada.',
      conflict_id: 'conflict-1',
    });
    expect(fixture.recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'financial_category_identity',
        defaultWinnerEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    );
  });
});

function managerFixture(
  options: {
    duplicate?: EventEntity | null;
    existing?: FinancialCategoryEntity | null;
  } = {},
) {
  const created: Array<{
    target: EntityTarget<unknown>;
    value: Record<string, unknown>;
  }> = [];
  const recordConflict = jest
    .fn()
    .mockResolvedValue({ conflictId: 'conflict-1' });
  const existing = Object.prototype.hasOwnProperty.call(options, 'existing')
    ? (options.existing ?? null)
    : null;
  const duplicate = options.duplicate ?? null;
  const manager = {
    findOneBy: jest.fn(
      (target: EntityTarget<unknown>, criteria: Record<string, unknown>) => {
        if (target === EventEntity && criteria.eventId) {
          return Promise.resolve(duplicate);
        }
        if (target === FinancialCategoryEntity && criteria.id) {
          return Promise.resolve(existing);
        }
        return Promise.resolve(null);
      },
    ),
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
      created.push({
        target,
        value: (Array.isArray(value) ? value : [value])[0] as Record<
          string,
          unknown
        >,
      });
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
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Renta',
    direction: 'out',
    nature: 'operating',
    active: true,
    version: 1,
    createdEventId: '22222222-2222-4222-8222-222222222222',
    lastEventId: '22222222-2222-4222-8222-222222222222',
    lastServerSequence: '10',
    ...overrides,
  });
}

function eventRecord({ eventId }: { eventId: string }): EventEntity {
  return {
    eventId,
    aggregateType: 'financial_category',
    aggregateId: '11111111-1111-4111-8111-111111111111',
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
    syncStatus: 'synced' as EventEntity['syncStatus'],
    rejectionReason: null,
    updatedAtServer: new Date('2026-09-24T14:38:05.000Z'),
  };
}
