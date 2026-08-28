import type { EntityManager } from 'typeorm';
import { CategoryEntity } from '../entities/category.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { ProductEntity } from '../entities/product.entity';
import type { PushEventDto } from './dto/push-events.dto';
import { CategoriaEventHandler } from './categoria-event.handler';
import type { SyncConflictService } from './sync-conflict.service';

describe('CategoriaEventHandler', () => {
  it('declara los eventos de categoría que puede procesar', () => {
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    expect(handler.supports('categoria_creada')).toBe(true);
    expect(handler.supports('categoria_actualizada')).toBe(true);
    expect(handler.supports('categoria_movida')).toBe(true);
    expect(handler.supports('categoria_eliminada')).toBe(true);
  });

  it('acepta categoria_creada, la agrega al final y guarda su referencia', async () => {
    const fixture = managerFixture();
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(fixture.manager, event());

    expect(result.status).toBe('accepted');
    const category = fixture.created.find(
      (entry) => entry.target === CategoryEntity,
    );
    expect(category?.value).toEqual(
      expect.objectContaining({
        name: 'Bebidas',
        colorKey: 'cyan',
        sortOrder: 0,
      }),
    );
    const ref = fixture.created.find(
      (entry) => entry.target === EventRefEntity,
    );
    expect(ref?.value).toEqual(
      expect.objectContaining({
        refType: 'category',
        relationship: 'affects',
        source: 'server',
      }),
    );
  });

  it('rechaza colores fuera de la paleta controlada', async () => {
    const fixture = managerFixture();
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const invalid = event();
    invalid.payload.color_key = 'ultraviolet';
    const result = await handler.apply(fixture.manager, invalid);

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('paleta permitida');
    expect(
      fixture.created.some((entry) => entry.target === CategoryEntity),
    ).toBe(false);
  });

  it('permite guardar nombres duplicados en ids distintos', async () => {
    const fixture = managerFixture();
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    await handler.apply(fixture.manager, event());
    await handler.apply(
      fixture.manager,
      event({
        event_id: '00000000-0000-4000-8000-000000000003',
        aggregate_id: '00000000-0000-4000-8000-000000000004',
      }),
    );

    const categories = fixture.created.filter(
      (entry) => entry.target === CategoryEntity,
    );
    expect(categories).toHaveLength(2);
    expect(categories.map((entry) => entry.value['name'])).toEqual([
      'Bebidas',
      'Bebidas',
    ]);
    expect(categories.map((entry) => entry.value['sortOrder'])).toEqual([0, 1]);
  });

  it('acepta categoria_actualizada y conserva trazabilidad', async () => {
    const existing = category();
    const fixture = managerFixture({ existing });
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      updatedEvent({
        base_server_sequence: 10,
        base_version: 1,
      }),
    );

    expect(result.status).toBe('accepted');
    expect(existing).toEqual(
      expect.objectContaining({
        name: 'Bebidas frías',
        colorKey: 'cyan',
        version: 2,
        lastEventId: '00000000-0000-4000-8000-000000000005',
        lastServerSequence: '12',
      }),
    );
  });

  it('fusiona una edición cuando el servidor cambió otra columna', async () => {
    const existing = category({
      colorKey: 'blue',
      version: 2,
      lastServerSequence: '11',
    });
    const fixture = managerFixture({
      existing,
      interveningEvents: [acceptedUpdate(['color_key'])],
    });
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      updatedEvent({
        base_server_sequence: 10,
        base_version: 1,
      }),
    );

    expect(result.status).toBe('accepted');
    expect(existing.name).toBe('Bebidas frías');
    expect(existing.colorKey).toBe('blue');
    expect(existing.version).toBe(3);
  });

  it('marca conflicto cuando el servidor cambió la misma columna', async () => {
    const existing = category({
      name: 'Bebidas premium',
      version: 2,
      lastServerSequence: '11',
    });
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const fixture = managerFixture({
      existing,
      interveningEvents: [acceptedUpdate(['name'])],
    });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      updatedEvent({
        base_server_sequence: 10,
        base_version: 1,
      }),
    );

    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('name');
    expect(existing.name).toBe('Bebidas premium');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'concurrent_field_update',
        refType: 'category',
      }),
    );
  });

  it('rechaza actualizaciones sin base o con campos no permitidos', async () => {
    const fixture = managerFixture({ existing: category() });
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );
    const withoutBase = updatedEvent({
      base_server_sequence: null,
      base_version: null,
    });
    const unknownField = updatedEvent({
      payload: {
        base_event_id: '00000000-0000-4000-8000-000000000001',
        changed_fields: ['sort_order'],
        changes: { sort_order: { from: null, to: 1 } },
      },
    });

    const withoutBaseResult = await handler.apply(fixture.manager, withoutBase);
    const unknownFieldResult = await handler.apply(
      fixture.manager,
      unknownField,
    );

    expect(withoutBaseResult.status).toBe('rejected');
    expect(withoutBaseResult.reason).toContain('base_version');
    expect(unknownFieldResult.status).toBe('rejected');
    expect(unknownFieldResult.reason).toContain('campos inválidos');
  });

  it('acepta categoria_movida y actualiza ambas categorías', async () => {
    const moved = category({ sortOrder: 1 });
    const displaced = category({
      id: '00000000-0000-4000-8000-000000000006',
      sortOrder: 0,
      version: 2,
      createdEventId: '00000000-0000-4000-8000-000000000007',
      lastEventId: '00000000-0000-4000-8000-000000000007',
      lastServerSequence: '9',
    });
    const fixture = managerFixture({ categories: [moved, displaced] });
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(fixture.manager, movedEvent());

    expect(result.status).toBe('accepted');
    expect(moved.sortOrder).toBe(0);
    expect(displaced.sortOrder).toBe(1);
    expect(moved.version).toBe(2);
    expect(displaced.version).toBe(3);
    expect(moved.lastEventId).toBe('00000000-0000-4000-8000-000000000008');
    const refs = fixture.created.filter(
      (entry) => entry.target === EventRefEntity,
    );
    expect(refs.map((entry) => entry.value['refId'])).toEqual([
      moved.id,
      displaced.id,
    ]);
  });

  it('marca conflicto si una posición oficial ya cambió', async () => {
    const moved = category({ sortOrder: 2 });
    const displaced = category({
      id: '00000000-0000-4000-8000-000000000006',
      sortOrder: 0,
      version: 2,
      createdEventId: '00000000-0000-4000-8000-000000000007',
      lastEventId: '00000000-0000-4000-8000-000000000007',
      lastServerSequence: '9',
    });
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const fixture = managerFixture({ categories: [moved, displaced] });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(fixture.manager, movedEvent());

    expect(result.status).toBe('conflict');
    expect(result.reason).toContain('orden oficial');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'concurrent_category_move',
      }),
    );
  });

  it('marca conflicto si el movimiento depende de una versión no aceptada', async () => {
    const moved = category({ sortOrder: 1 });
    const displaced = category({
      id: '00000000-0000-4000-8000-000000000006',
      sortOrder: 0,
      version: 2,
      createdEventId: '00000000-0000-4000-8000-000000000007',
      lastEventId: '00000000-0000-4000-8000-000000000007',
      lastServerSequence: '9',
    });
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const fixture = managerFixture({ categories: [moved, displaced] });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      movedEvent({ base_version: 3 }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'stale_category_move_base',
      }),
    );
  });

  it('acepta categoria_eliminada, hace hard delete, compacta y guarda refs', async () => {
    const deleted = category();
    const shifted = category({
      id: '00000000-0000-4000-8000-000000000006',
      name: 'Comida',
      sortOrder: 1,
      version: 2,
      createdEventId: '00000000-0000-4000-8000-000000000007',
      lastEventId: '00000000-0000-4000-8000-000000000007',
      lastServerSequence: '11',
    });
    const fixture = managerFixture({ categories: [deleted, shifted] });
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const deletion = deletedEvent({
      payload: { ...deletedEvent().payload, future_field: true },
    });
    const result = await handler.apply(fixture.manager, deletion);

    expect(result.status).toBe('accepted');
    expect(fixture.categories.map((value) => value.id)).toEqual([shifted.id]);
    expect(shifted.sortOrder).toBe(0);
    expect(shifted.version).toBe(3);
    const refs = fixture.created.filter(
      (entry) => entry.target === EventRefEntity,
    );
    expect(refs.map((entry) => entry.value['refId'])).toEqual([
      deleted.id,
      shifted.id,
    ]);
    const storedEvent = fixture.created.find(
      (entry) => entry.target === EventEntity,
    );
    expect(storedEvent?.value['payload']).not.toHaveProperty('future_field');
  });

  it.each([
    { name: 'primera', count: 4, deletedIndex: 0 },
    { name: 'intermedia', count: 4, deletedIndex: 2 },
    { name: 'última', count: 4, deletedIndex: 3 },
    { name: 'única', count: 1, deletedIndex: 0 },
  ])(
    'elimina categoría $name y conserva orden consecutivo',
    async ({ count, deletedIndex }) => {
      const categories = Array.from({ length: count }, (_, index) =>
        category({
          id: `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
          name: `Categoría ${index}`,
          sortOrder: index,
          createdEventId: `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
          lastEventId: `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
          lastServerSequence: `${10 + index}`,
        }),
      );
      const deleted = categories[deletedIndex];
      const payload = {
        base_event_id: deleted.lastEventId,
        deleted_category: {
          name: deleted.name,
          color_key: deleted.colorKey,
          sort_order: deleted.sortOrder,
          active: deleted.active,
          created_event_id: deleted.createdEventId,
        },
        product_resolution: { type: 'none' },
        linked_products: [],
        shifted_categories: categories
          .slice(deletedIndex + 1)
          .map((shifted) => ({
            category_id: shifted.id,
            base_event_id: shifted.lastEventId,
            base_version: shifted.version,
            base_server_sequence: Number(shifted.lastServerSequence),
            sort_order: {
              from: shifted.sortOrder,
              to: shifted.sortOrder - 1,
            },
          })),
      };
      const fixture = managerFixture({ categories });
      const handler = new CategoriaEventHandler(
        {} as unknown as SyncConflictService,
      );

      const result = await handler.apply(
        fixture.manager,
        deletedEvent({
          aggregate_id: deleted.id,
          base_server_sequence: Number(deleted.lastServerSequence),
          base_version: deleted.version,
          payload,
        }),
      );

      expect(result.status).toBe('accepted');
      expect(fixture.categories.map((value) => value.id)).not.toContain(
        deleted.id,
      );
      expect(fixture.categories.map((value) => value.sortOrder)).toEqual(
        Array.from({ length: count - 1 }, (_, index) => index),
      );
    },
  );

  it.each([true, false])(
    'categoría con producto active=%s produce category_linked_products_changed',
    async (active) => {
      const recordConflict = jest.fn().mockResolvedValue({
        conflictId: '00000000-0000-4000-8000-000000000099',
      });
      const existing = category();
      const fixture = managerFixture({
        existing,
        products: [{ categoryId: existing.id, active } as ProductEntity],
      });
      const handler = new CategoriaEventHandler({
        recordConflict,
      } as unknown as SyncConflictService);

      const result = await handler.apply(
        fixture.manager,
        deletedEvent({
          payload: { ...deletedEvent().payload, shifted_categories: [] },
        }),
      );

      expect(result.status).toBe('conflict');
      expect(recordConflict).toHaveBeenCalledWith(
        fixture.manager,
        expect.objectContaining({
          conflictType: 'category_linked_products_changed',
        }),
      );
    },
  );

  it('mueve productos activos e inactivos, compacta y guarda refs oficiales', async () => {
    const source = category();
    const destination = category({
      id: '00000000-0000-4000-8000-000000000006',
      name: 'Comida',
      sortOrder: 1,
      version: 2,
      createdEventId: '00000000-0000-4000-8000-000000000007',
      lastEventId: '00000000-0000-4000-8000-000000000007',
      lastServerSequence: '11',
    });
    const products = [product(), product({ id: PRODUCT_2_ID, active: false })];
    const fixture = managerFixture({
      categories: [source, destination],
      products,
    });
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      deletedProductsEvent({ move: true }),
    );

    expect(result.status).toBe('accepted');
    expect(products.every((value) => value.categoryId === destination.id)).toBe(
      true,
    );
    expect(products.every((value) => value.version === 3)).toBe(true);
    expect(
      products.every(
        (value) =>
          value.lastEventId === '00000000-0000-4000-8000-000000000008' &&
          value.lastServerSequence === '12',
      ),
    ).toBe(true);
    expect(fixture.categories).toEqual([destination]);
    expect(destination.sortOrder).toBe(0);
    const refs = fixture.created
      .filter((entry) => entry.target === EventRefEntity)
      .map((entry) =>
        [
          entry.value['refType'],
          entry.value['refId'],
          entry.value['relationship'],
        ]
          .map(String)
          .join(':'),
      );
    expect(refs).toEqual([
      `category:${source.id}:affects`,
      `category:${destination.id}:affects`,
      `product:${PRODUCT_1_ID}:affects`,
      `product:${PRODUCT_2_ID}:affects`,
      `category:${destination.id}:uses`,
    ]);
  });

  it('deja varios productos sin categoría sin modificar active', async () => {
    const source = category();
    const products = [product(), product({ id: PRODUCT_2_ID, active: false })];
    const fixture = managerFixture({ existing: source, products });
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      deletedProductsEvent({ move: false }),
    );

    expect(result.status).toBe('accepted');
    expect(products.every((value) => value.categoryId === null)).toBe(true);
    expect(products.map((value) => value.active)).toEqual([true, false]);
    expect(products.every((value) => value.version === 3)).toBe(true);
  });

  it('marca cambio del conjunto cuando aparece un producto nuevo', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const source = category();
    const products = [
      product(),
      product({ id: PRODUCT_2_ID }),
      product({ id: '00000000-0000-4000-8000-000000000013' }),
    ];
    const fixture = managerFixture({ existing: source, products });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      deletedProductsEvent({ move: false }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'category_linked_products_changed',
      }),
    );
    expect(products.every((value) => value.categoryId === source.id)).toBe(
      true,
    );
  });

  it('marca producto concurrente si cambió su categoría o base', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const moved = product({ categoryId: null, version: 3 });
    const fixture = managerFixture({ existing: category(), products: [moved] });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);
    const event = deletedProductsEvent({ move: false });
    (event.payload.linked_products as unknown[]) = [
      linkedProductPayload(PRODUCT_1_ID, null),
    ];

    const result = await handler.apply(fixture.manager, event);

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'concurrent_product_category_update',
      }),
    );
  });

  it('marca missing_aggregate si falta un producto confirmado', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const fixture = managerFixture({
      existing: category(),
      products: [product()],
    });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      deletedProductsEvent({ move: false }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({ conflictType: 'missing_aggregate' }),
    );
  });

  it('marca concurrent_category_delete si cambió la base del destino', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const source = category();
    const destination = category({
      id: '00000000-0000-4000-8000-000000000006',
      name: 'Comida',
      sortOrder: 1,
      version: 3,
      createdEventId: '00000000-0000-4000-8000-000000000007',
      lastEventId: '00000000-0000-4000-8000-000000000007',
      lastServerSequence: '11',
    });
    const fixture = managerFixture({
      categories: [source, destination],
      products: [product(), product({ id: PRODUCT_2_ID })],
    });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      deletedProductsEvent({ move: true }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({ conflictType: 'concurrent_category_delete' }),
    );
  });

  it('destino ausente produce missing_aggregate y destino igual se rechaza', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const source = category();
    const fixture = managerFixture({
      existing: source,
      products: [product()],
    });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const missing = await handler.apply(
      fixture.manager,
      deletedProductsEvent({ move: true }),
    );
    expect(missing.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({ conflictType: 'missing_aggregate' }),
    );

    const sameDestination = deletedProductsEvent({ move: true });
    const resolution = sameDestination.payload.product_resolution as Record<
      string,
      unknown
    >;
    (resolution.destination_category as Record<string, unknown>).category_id =
      source.id;
    const rejected = await handler.apply(fixture.manager, sameDestination);
    expect(rejected.status).toBe('rejected');
  });

  it('marca concurrent_category_delete si cambió la instantánea', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const fixture = managerFixture({ existing: category({ name: 'Nueva' }) });
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      deletedEvent({
        payload: { ...deletedEvent().payload, shifted_categories: [] },
      }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({ conflictType: 'concurrent_category_delete' }),
    );
  });

  it('marca missing_aggregate si la categoría ya no existe', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const fixture = managerFixture();
    const handler = new CategoriaEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      deletedEvent({
        payload: { ...deletedEvent().payload, shifted_categories: [] },
      }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({ conflictType: 'missing_aggregate' }),
    );
  });

  it('rechaza un payload de eliminación inválido', async () => {
    const fixture = managerFixture({ existing: category() });
    const handler = new CategoriaEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      deletedEvent({
        payload: {
          ...deletedEvent().payload,
          product_resolution: { type: 'delete' },
        },
      }),
    );

    expect(result.status).toBe('rejected');
    expect(fixture.categories).toHaveLength(1);
  });
});

function event(overrides: Partial<PushEventDto> = {}): PushEventDto {
  return {
    event_id: '00000000-0000-4000-8000-000000000001',
    aggregate_type: 'category',
    aggregate_id: '00000000-0000-4000-8000-000000000002',
    event_type: 'categoria_creada',
    device_id: 'device_tablet_01',
    user_id: 'user_01',
    local_sequence: 1,
    base_version: 1,
    created_at_local: '2026-07-18T20:30:00.000Z',
    payload: {
      name: ' Bebidas ',
      color_key: 'cyan',
      sort_order: 0,
    },
    ...overrides,
  };
}

function updatedEvent(overrides: Partial<PushEventDto> = {}): PushEventDto {
  return event({
    event_id: '00000000-0000-4000-8000-000000000005',
    event_type: 'categoria_actualizada',
    base_server_sequence: 10,
    base_version: 1,
    payload: {
      base_event_id: '00000000-0000-4000-8000-000000000001',
      changed_fields: ['name'],
      changes: {
        name: { from: 'Bebidas', to: 'Bebidas frías' },
      },
    },
    ...overrides,
  });
}

function movedEvent(overrides: Partial<PushEventDto> = {}): PushEventDto {
  return event({
    event_id: '00000000-0000-4000-8000-000000000008',
    event_type: 'categoria_movida',
    base_server_sequence: 10,
    base_version: 1,
    payload: {
      base_event_id: '00000000-0000-4000-8000-000000000001',
      changed_fields: ['sort_order'],
      changes: {
        sort_order: { from: 1, to: 0 },
      },
      displaced_category: {
        category_id: '00000000-0000-4000-8000-000000000006',
        base_event_id: '00000000-0000-4000-8000-000000000007',
        base_version: 2,
        base_server_sequence: 9,
        sort_order: { from: 0, to: 1 },
      },
    },
    ...overrides,
  });
}

function deletedEvent(overrides: Partial<PushEventDto> = {}): PushEventDto {
  return event({
    event_id: '00000000-0000-4000-8000-000000000008',
    event_type: 'categoria_eliminada',
    base_server_sequence: 10,
    base_version: 1,
    payload: {
      base_event_id: '00000000-0000-4000-8000-000000000001',
      deleted_category: {
        name: 'Bebidas',
        color_key: 'cyan',
        sort_order: 0,
        active: true,
        created_event_id: '00000000-0000-4000-8000-000000000001',
      },
      product_resolution: { type: 'none' },
      linked_products: [],
      shifted_categories: [
        {
          category_id: '00000000-0000-4000-8000-000000000006',
          base_event_id: '00000000-0000-4000-8000-000000000007',
          base_version: 2,
          base_server_sequence: 11,
          sort_order: { from: 1, to: 0 },
        },
      ],
    },
    ...overrides,
  });
}

const PRODUCT_1_ID = '00000000-0000-4000-8000-000000000009';
const PRODUCT_2_ID = '00000000-0000-4000-8000-000000000010';
const PRODUCT_1_BASE = '00000000-0000-4000-8000-000000000011';
const PRODUCT_2_BASE = '00000000-0000-4000-8000-000000000012';

function deletedProductsEvent({ move }: { move: boolean }): PushEventDto {
  return deletedEvent({
    payload: {
      base_event_id: '00000000-0000-4000-8000-000000000001',
      deleted_category: {
        name: 'Bebidas',
        color_key: 'cyan',
        sort_order: 0,
        active: true,
        created_event_id: '00000000-0000-4000-8000-000000000001',
      },
      product_resolution: move
        ? {
            type: 'move',
            destination_category: {
              category_id: '00000000-0000-4000-8000-000000000006',
              base_event_id: '00000000-0000-4000-8000-000000000007',
              base_version: 2,
              base_server_sequence: 11,
            },
          }
        : { type: 'uncategorize' },
      linked_products: [
        linkedProductPayload(
          PRODUCT_1_ID,
          move ? '00000000-0000-4000-8000-000000000006' : null,
        ),
        linkedProductPayload(
          PRODUCT_2_ID,
          move ? '00000000-0000-4000-8000-000000000006' : null,
        ),
      ],
      shifted_categories: move
        ? [
            {
              category_id: '00000000-0000-4000-8000-000000000006',
              base_event_id: '00000000-0000-4000-8000-000000000007',
              base_version: 2,
              base_server_sequence: 11,
              sort_order: { from: 1, to: 0 },
            },
          ]
        : [],
    },
  });
}

function linkedProductPayload(
  productId: string,
  destinationId: string | null,
): Record<string, unknown> {
  const second = productId === PRODUCT_2_ID;
  return {
    product_id: productId,
    base_event_id: second ? PRODUCT_2_BASE : PRODUCT_1_BASE,
    base_version: 2,
    base_server_sequence: second ? 21 : 20,
    category_id: {
      from: '00000000-0000-4000-8000-000000000002',
      to: destinationId,
    },
  };
}

function category(overrides: Partial<CategoryEntity> = {}): CategoryEntity {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Bebidas',
    colorKey: 'cyan',
    sortOrder: 0,
    active: true,
    version: 1,
    createdEventId: '00000000-0000-4000-8000-000000000001',
    lastEventId: '00000000-0000-4000-8000-000000000001',
    lastServerSequence: '10',
    createdAtServer: new Date('2026-07-18T20:30:00.000Z'),
    updatedAtServer: new Date('2026-07-18T20:30:00.000Z'),
    ...overrides,
  };
}

function product(overrides: Partial<ProductEntity> = {}): ProductEntity {
  const id = overrides.id ?? PRODUCT_1_ID;
  const second = id === PRODUCT_2_ID;
  return {
    id,
    name: 'Producto',
    categoryId: '00000000-0000-4000-8000-000000000002',
    category: null,
    active: true,
    version: 2,
    createdEventId: second ? PRODUCT_2_BASE : PRODUCT_1_BASE,
    lastEventId: second ? PRODUCT_2_BASE : PRODUCT_1_BASE,
    lastServerSequence: second ? '21' : '20',
    createdAtServer: new Date('2026-07-18T20:30:00.000Z'),
    updatedAtServer: new Date('2026-07-18T20:30:00.000Z'),
    ...overrides,
  };
}

function acceptedUpdate(changedFields: string[]): EventEntity {
  return {
    eventId: '00000000-0000-4000-8000-000000000080',
    aggregateType: 'category',
    aggregateId: '00000000-0000-4000-8000-000000000002',
    eventType: 'categoria_actualizada',
    deviceId: 'other_device',
    userId: 'user_02',
    localSequence: 2,
    serverSequence: '11',
    baseServerSequence: '10',
    baseVersion: 1,
    createdAtLocal: new Date('2026-07-18T20:30:00.000Z'),
    createdAtServer: new Date('2026-07-18T20:31:00.000Z'),
    payload: { changed_fields: changedFields, changes: {} },
    syncStatus: 'synced',
    rejectionReason: null,
    updatedAtServer: new Date('2026-07-18T20:31:00.000Z'),
  } as EventEntity;
}

function managerFixture(): {
  manager: EntityManager;
  created: Array<{ target: unknown; value: Record<string, unknown> }>;
  categories: CategoryEntity[];
};
function managerFixture(options?: {
  existing?: CategoryEntity | null;
  categories?: CategoryEntity[];
  interveningEvents?: EventEntity[];
  products?: ProductEntity[];
}): {
  manager: EntityManager;
  created: Array<{ target: unknown; value: Record<string, unknown> }>;
  categories: CategoryEntity[];
};
function managerFixture(
  options: {
    existing?: CategoryEntity | null;
    categories?: CategoryEntity[];
    interveningEvents?: EventEntity[];
    products?: ProductEntity[];
  } = {},
): {
  manager: EntityManager;
  created: Array<{ target: unknown; value: Record<string, unknown> }>;
  categories: CategoryEntity[];
} {
  const created: Array<{
    target: unknown;
    value: Record<string, unknown>;
  }> = [];
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(options.interveningEvents ?? []),
  };
  const categories =
    options.categories ?? (options.existing ? [options.existing] : []);
  const manager = {
    query: jest.fn().mockResolvedValue([]),
    find: jest
      .fn()
      .mockImplementation(
        (
          target: unknown,
          findOptions?: { where?: { categoryId?: string } },
        ) => {
          if (target === CategoryEntity) return Promise.resolve(categories);
          if (target === ProductEntity) {
            const products = options.products ?? [];
            const categoryId = findOptions?.where?.categoryId;
            return Promise.resolve(
              categoryId === undefined
                ? products
                : products.filter(
                    (product) => product.categoryId === categoryId,
                  ),
            );
          }
          return Promise.resolve([]);
        },
      ),
    count: jest.fn().mockImplementation((target: unknown) => {
      return Promise.resolve(
        target === ProductEntity ? (options.products ?? []).length : 0,
      );
    }),
    findOneBy: jest
      .fn()
      .mockImplementation((target: unknown, where: { id?: string }) => {
        if (target !== CategoryEntity) return Promise.resolve(null);
        return Promise.resolve(
          categories.find((category) => category.id === where.id) ?? null,
        );
      }),
    findOne: jest
      .fn()
      .mockImplementation(
        (target: unknown, findOptions: { where?: { id?: string } }) => {
          if (target === CategoryEntity) {
            return Promise.resolve(
              categories.find(
                (category) => category.id === findOptions.where?.id,
              ) ?? null,
            );
          }
          if (target === ProductEntity) {
            return Promise.resolve(
              (options.products ?? []).find(
                (product) => product.id === findOptions.where?.id,
              ) ?? null,
            );
          }
          return Promise.resolve(null);
        },
      ),
    getRepository: jest.fn().mockReturnValue({
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    }),
    create: jest.fn((target: unknown, value: Record<string, unknown>) => {
      const entity = { ...value };
      created.push({ target, value: entity });
      return entity;
    }),
    save: jest.fn(
      (value: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const values = Array.isArray(value) ? value : [value];
        for (const entity of values) {
          if ('eventId' in entity && 'syncStatus' in entity) {
            entity.serverSequence = '12';
            entity.createdAtServer = new Date('2026-07-18T20:31:00.000Z');
          }
          if (
            'id' in entity &&
            'name' in entity &&
            'sortOrder' in entity &&
            !categories.some((category) => category.id === entity.id)
          ) {
            categories.push(entity as unknown as CategoryEntity);
          }
        }
        return Promise.resolve(value);
      },
    ),
    remove: jest.fn((value: CategoryEntity) => {
      const index = categories.indexOf(value);
      if (index >= 0) categories.splice(index, 1);
      return Promise.resolve(value);
    }),
  } as unknown as EntityManager;

  return { manager, created, categories };
}
