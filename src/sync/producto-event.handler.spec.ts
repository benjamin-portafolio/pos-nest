import type { EntityManager, EntityTarget } from 'typeorm';
import { CategoryEntity } from '../entities/category.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { ProductEntity } from '../entities/product.entity';
import { RecipeComponentEntity } from '../entities/recipe-component.entity';
import { UnitEntity } from '../entities/unit.entity';
import type { PushEventDto } from './dto/push-events.dto';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { ProductoEventHandler } from './producto-event.handler';
import type { SyncConflictService } from './sync-conflict.service';

describe('ProductoEventHandler', () => {
  it('declara la creación del agregado producto', () => {
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    expect(handler.supports('producto_creado')).toBe(true);
  });

  it('acepta producto_creado y guarda producto, variante y referencias', async () => {
    const fixture = managerFixture();
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(fixture.manager, productEvent());

    expect(result.status).toBe('accepted');
    expect(
      fixture.created.find((entry) => entry.target === ProductEntity)?.value,
    ).toEqual(
      expect.objectContaining({
        name: 'Café americano',
        categoryId: null,
        active: true,
      }),
    );
    expect(
      fixture.created.find((entry) => entry.target === ProductVariantEntity)
        ?.value,
    ).toEqual(
      expect.objectContaining({
        salePriceMinor: '4550',
        sortOrder: 0,
      }),
    );
    const refs = fixture.created.filter(
      (entry) => entry.target === EventRefEntity,
    );
    expect(refs.map((entry) => entry.value['refType'])).toEqual([
      'product',
      'product_variant',
    ]);
  });

  it('guarda varias variantes, costos y referencias de nombre', async () => {
    const fixture = managerFixture();
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload: advancedProductPayload() }),
    );

    expect(result.status).toBe('accepted');
    const variants = fixture.created.filter(
      (entry) => entry.target === ProductVariantEntity,
    );
    expect(variants.map((entry) => entry.value)).toEqual([
      expect.objectContaining({
        name: 'Grande',
        nameKey: 'grande',
        salePriceMinor: '1000',
        standardCostMinor: '200',
        sortOrder: 0,
      }),
      expect.objectContaining({
        name: null,
        nameKey: null,
        salePriceMinor: '1200',
        standardCostMinor: '0',
        sortOrder: 1,
      }),
    ]);
    const refs = fixture.created.filter(
      (entry) => entry.target === EventRefEntity,
    );
    expect(refs.map((entry) => entry.value['refType'])).toEqual([
      'product',
      'product_variant',
      'product_variant_name',
      'product_variant',
    ]);
    expect(refs[2].value['relationship']).toBe('requires_unique');
    expect(refs[2].value['refId']).toBe(
      '00000000-0000-4000-8000-000000000002:Z3JhbmRl',
    );
  });

  it('vincula una variante con un recurso activo y conserva la referencia uses', async () => {
    const item = inventoryItem();
    const fixture = managerFixture({
      inventoryItem: item,
      unit: pieceUnit(),
      baseEvent: inventoryCreationEvent(),
    });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload: trackedProductPayload() }),
    );

    expect(result.status).toBe('accepted');
    expect(
      fixture.created.find((entry) => entry.target === ProductVariantEntity)
        ?.value,
    ).toEqual(expect.objectContaining({ inventoryItemId: item.id }));
    expect(
      fixture.created.find(
        (entry) =>
          entry.target === EventRefEntity &&
          entry.value['refType'] === 'inventory_item',
      )?.value['relationship'],
    ).toBe('uses');
    const savedEvent = fixture.created.find(
      (entry) => entry.target === EventEntity,
    )?.value;
    expect(
      (
        (savedEvent?.['payload'] as Record<string, unknown>)[
          'dependencies'
        ] as Array<Record<string, unknown>>
      )[0],
    ).toEqual({
      ref_type: 'inventory_item',
      ref_id: item.id,
    });
  });

  it('guarda la receta, su referencia y el payload canónico', async () => {
    const item = inventoryItem({
      defaultUnitId: '00000000-0000-4000-8000-000000000020',
    });
    const fixture = managerFixture({
      inventoryItem: item,
      unit: kilogramUnit(),
      baseEvent: inventoryCreationEvent(),
    });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload: recipeProductPayload() }),
    );

    expect(result.status).toBe('accepted');
    expect(
      fixture.created.find((entry) => entry.target === RecipeComponentEntity)
        ?.value,
    ).toEqual({
      variantId: '00000000-0000-4000-8000-000000000003',
      inventoryItemId: item.id,
      quantityAtomic: '250',
    });
    expect(
      fixture.created.find(
        (entry) =>
          entry.target === EventRefEntity &&
          entry.value['refType'] === 'recipe',
      )?.value,
    ).toEqual(
      expect.objectContaining({
        refId: '00000000-0000-4000-8000-000000000003',
        relationship: 'affects',
      }),
    );
    const savedEvent = fixture.created.find(
      (entry) => entry.target === EventEntity,
    )?.value;
    const savedPayload = savedEvent?.['payload'] as Record<string, unknown>;
    const savedVariant = (
      savedPayload['variants'] as Array<Record<string, unknown>>
    )[0];
    expect(savedVariant['inventory_configuration']).toEqual({
      enabled: true,
      components: [{ inventory_item_id: item.id, quantity_atomic: 250 }],
    });
    expect(savedPayload['dependencies']).toEqual([
      { ref_type: 'inventory_item', ref_id: item.id },
    ]);
  });

  it('no crea la receta cuando un ingrediente está inactivo', async () => {
    const fixture = managerFixture({
      inventoryItem: inventoryItem({ active: false }),
      unit: pieceUnit(),
    });
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const handler = new ProductoEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload: recipeProductPayload() }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'missing_dependency',
        refType: 'inventory_item',
      }),
    );
    expect(
      fixture.created.some((entry) => entry.target === RecipeComponentEntity),
    ).toBe(false);
  });

  it('rechaza seguimiento por unidad cuando el recurso no usa piezas', async () => {
    const fixture = managerFixture({
      inventoryItem: inventoryItem(),
      unit: kilogramUnit(),
      baseEvent: inventoryCreationEvent(),
    });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload: trackedProductPayload() }),
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('piezas');
    expect(
      fixture.created.some((entry) => entry.target === ProductEntity),
    ).toBe(false);
  });

  it('una colisión de cualquier variant_id no crea proyecciones parciales', async () => {
    const colliding = Object.assign(new ProductVariantEntity(), {
      id: '00000000-0000-4000-8000-000000000004',
      createdEventId: '00000000-0000-4000-8000-000000000099',
    });
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000098',
    });
    const fixture = managerFixture({ variants: [colliding] });
    const handler = new ProductoEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload: advancedProductPayload() }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'variant_id_conflict',
        refId: colliding.id,
      }),
    );
    expect(
      fixture.created.some((entry) => entry.target === ProductEntity),
    ).toBe(false);
    expect(
      fixture.created.some((entry) => entry.target === ProductVariantEntity),
    ).toBe(false);
  });

  it.each(['unit', 'measured'])(
    'crea un artículo con venta %s',
    async (saleMode) => {
      const fixture = managerFixture({ unit: kilogramUnit() });
      const handler = new ProductoEventHandler(
        {} as unknown as SyncConflictService,
      );
      const payload =
        saleMode === 'measured'
          ? measuredProductPayload()
          : productPayload(null, 10);

      const result = await handler.apply(
        fixture.manager,
        productEvent({ payload }),
      );

      expect(result.status).toBe('accepted');
      expect(
        fixture.created.find((entry) => entry.target === ProductEntity)?.value,
      ).toEqual(
        expect.objectContaining({
          saleMode,
          saleUnitId:
            saleMode === 'measured'
              ? '00000000-0000-4000-8000-000000000020'
              : null,
        }),
      );
      expect(
        fixture.created.some((entry) => entry.target === ProductVariantEntity),
      ).toBe(true);
    },
  );

  it.each([
    ['inexistente', undefined, 'No existe'],
    ['inactiva', kilogramUnit({ active: false }), 'no está activa'],
    ['de conteo', kilogramUnit({ dimension: 'count' }), 'masa o volumen'],
    [
      'con factor distinto',
      kilogramUnit({ atomicFactor: '1' }),
      'atomicFactor',
    ],
  ])('rechaza unidad %s sin crear proyecciones', async (_, unit, reason) => {
    const fixture = managerFixture({ unit });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload: measuredProductPayload() }),
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain(reason);
    expect(
      fixture.created.some((entry) => entry.target === ProductEntity),
    ).toBe(false);
    expect(
      fixture.created.some((entry) => entry.target === ProductVariantEntity),
    ).toBe(false);
  });

  it('rechaza measured sin unidad', async () => {
    const fixture = managerFixture();
    const payload = measuredProductPayload();
    const product = payload.product as Record<string, unknown>;
    const configuration = product.sale_configuration as Record<string, unknown>;
    delete configuration.sale_unit_id;
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload }),
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('sale_unit_id');
  });

  it('rechaza campos medidos bajo unit', async () => {
    const fixture = managerFixture();
    const payload = productPayload(null);
    const product = payload.product as Record<string, unknown>;
    product.sale_configuration = {
      mode: 'unit',
      sale_unit_id: '00000000-0000-4000-8000-000000000020',
      price_reference_quantity_atomic: 1000,
    };
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload }),
    );

    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('no admite campos medidos');
  });

  it('aplica idempotentemente el mismo evento', async () => {
    const existingEvent = Object.assign(new EventEntity(), {
      eventId: '00000000-0000-4000-8000-000000000001',
      serverSequence: '11',
      createdAtServer: new Date('2026-08-05T20:31:00.000Z'),
    });
    const fixture = managerFixture({
      product: Object.assign(new ProductEntity(), {
        id: '00000000-0000-4000-8000-000000000002',
        createdEventId: existingEvent.eventId,
      }),
      variant: Object.assign(new ProductVariantEntity(), {
        id: '00000000-0000-4000-8000-000000000003',
        createdEventId: existingEvent.eventId,
      }),
      existingEvent,
    });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(fixture.manager, productEvent());

    expect(result.status).toBe('accepted');
    expect(result.server_sequence).toBe(11);
    expect(fixture.created).toHaveLength(0);
  });

  it('marca conflicto cuando la categoría dependiente no existe', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const fixture = managerFixture();
    const handler = new ProductoEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      productEvent({
        payload: productPayload('00000000-0000-4000-8000-000000000010'),
      }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({
        conflictType: 'missing_dependency',
        refType: 'category',
      }),
    );
  });

  it('acepta una categoría existente y conserva su referencia uses', async () => {
    const fixture = managerFixture({
      category: category(),
    });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({
        payload: productPayload('00000000-0000-4000-8000-000000000010'),
      }),
    );

    expect(result.status).toBe('accepted');
    const categoryRef = fixture.created.find(
      (entry) =>
        entry.target === EventRefEntity &&
        entry.value['refType'] === 'category',
    );
    expect(categoryRef?.value['relationship']).toBe('uses');
  });

  it('acepta una categoría oficial sin dependencia de evento', async () => {
    const fixture = managerFixture({ category: category() });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );
    const payload = productPayload('00000000-0000-4000-8000-000000000010');
    payload.dependencies = [];

    const result = await handler.apply(
      fixture.manager,
      productEvent({ payload }),
    );

    expect(result.status).toBe('accepted');
    expect(
      fixture.created.find((entry) => entry.target === EventEntity)?.value[
        'payload'
      ],
    ).toEqual(expect.objectContaining({ dependencies: [] }));
  });

  it('acepta dependencia al evento de creación de una categoría local', async () => {
    const baseEvent = Object.assign(new EventEntity(), {
      eventId: '00000000-0000-4000-8000-000000000011',
      aggregateType: 'category',
      aggregateId: '00000000-0000-4000-8000-000000000010',
      eventType: 'categoria_creada',
      syncStatus: EventSyncStatus.SYNCED,
    });
    const fixture = managerFixture({ category: category(), baseEvent });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({
        payload: productPayloadWithCreationDependency(
          '00000000-0000-4000-8000-000000000010',
        ),
      }),
    );

    expect(result.status).toBe('accepted');
  });

  it('acepta una categoría desplazada por el último movimiento legado', async () => {
    const baseEvent = Object.assign(new EventEntity(), {
      eventId: '00000000-0000-4000-8000-000000000011',
      aggregateType: 'category',
      aggregateId: '00000000-0000-4000-8000-000000000012',
      eventType: 'categoria_movida',
      syncStatus: EventSyncStatus.SYNCED,
    });
    const fixture = managerFixture({
      category: category(),
      baseEvent,
      baseEventRef: Object.assign(new EventRefEntity(), {
        eventId: baseEvent.eventId,
        refType: 'category',
        refId: '00000000-0000-4000-8000-000000000010',
        relationship: 'affects',
      }),
    });
    const handler = new ProductoEventHandler(
      {} as unknown as SyncConflictService,
    );

    const result = await handler.apply(
      fixture.manager,
      productEvent({
        payload: productPayload('00000000-0000-4000-8000-000000000010'),
      }),
    );

    expect(result.status).toBe('accepted');
  });

  it('marca dependency_failed si la base local de categoría no llegó', async () => {
    const recordConflict = jest.fn().mockResolvedValue({
      conflictId: '00000000-0000-4000-8000-000000000099',
    });
    const fixture = managerFixture({ category: category() });
    const handler = new ProductoEventHandler({
      recordConflict,
    } as unknown as SyncConflictService);

    const result = await handler.apply(
      fixture.manager,
      productEvent({
        payload: productPayloadWithCreationDependency(
          '00000000-0000-4000-8000-000000000010',
        ),
      }),
    );

    expect(result.status).toBe('conflict');
    expect(recordConflict).toHaveBeenCalledWith(
      fixture.manager,
      expect.objectContaining({ conflictType: 'dependency_failed' }),
    );
  });
});

function productEvent(overrides: Partial<PushEventDto> = {}): PushEventDto {
  return {
    event_id: '00000000-0000-4000-8000-000000000001',
    aggregate_type: 'product',
    aggregate_id: '00000000-0000-4000-8000-000000000002',
    event_type: 'producto_creado',
    device_id: 'device_tablet_01',
    user_id: 'user_01',
    local_sequence: 1,
    base_server_sequence: null,
    base_version: 1,
    created_at_local: '2026-08-05T20:30:00.000Z',
    payload: productPayload(null),
    ...overrides,
  };
}

function productPayload(
  categoryId: string | null,
  baseServerSequence: number | null = 10,
): Record<string, unknown> {
  return {
    product: {
      name: '  Ｃａｆé americano  ',
      category_id: categoryId,
      sale_configuration: { mode: 'unit' },
    },
    variants: [
      {
        variant_id: '00000000-0000-4000-8000-000000000003',
        name: null,
        sku: null,
        barcode: null,
        sale_price_minor: 4550,
        sort_order: 0,
      },
    ],
    dependencies: categoryId
      ? [
          {
            ref_type: 'category',
            ref_id: categoryId,
            base_event_id: '00000000-0000-4000-8000-000000000011',
            base_version: 1,
            base_server_sequence: baseServerSequence,
          },
        ]
      : [],
  };
}

function measuredProductPayload(): Record<string, unknown> {
  const payload = productPayload(null, null);
  payload.product = {
    name: 'Queso',
    category_id: null,
    sale_configuration: {
      mode: 'measured',
      sale_unit_id: '00000000-0000-4000-8000-000000000020',
      price_reference_quantity_atomic: 1000,
    },
  };
  payload.dependencies = [
    {
      ref_type: 'unit',
      ref_id: '00000000-0000-4000-8000-000000000020',
    },
  ];
  return payload;
}

function trackedProductPayload(): Record<string, unknown> {
  const payload = productPayload(null, null);
  (payload.variants as Array<Record<string, unknown>>)[0].inventory_item_id =
    '00000000-0000-4000-8000-000000000030';
  payload.dependencies = [
    {
      ref_type: 'inventory_item',
      ref_id: '00000000-0000-4000-8000-000000000030',
      depends_on_event_id: '00000000-0000-4000-8000-000000000031',
    },
  ];
  return payload;
}

function recipeProductPayload(): Record<string, unknown> {
  const payload = productPayload(null, null);
  (
    payload.variants as Array<Record<string, unknown>>
  )[0].inventory_configuration = {
    enabled: true,
    components: [
      {
        inventory_item_id: '00000000-0000-4000-8000-000000000030',
        quantity_atomic: 250,
      },
    ],
  };
  payload.dependencies = [
    {
      ref_type: 'inventory_item',
      ref_id: '00000000-0000-4000-8000-000000000030',
      depends_on_event_id: '00000000-0000-4000-8000-000000000031',
    },
  ];
  return payload;
}

function advancedProductPayload(): Record<string, unknown> {
  const payload = productPayload(null, null);
  payload.variants = [
    {
      variant_id: '00000000-0000-4000-8000-000000000003',
      name: '  Ｇｒａｎｄｅ  ',
      sku: null,
      barcode: null,
      sale_price_minor: 1000,
      standard_cost_minor: 200,
      sort_order: 0,
    },
    {
      variant_id: '00000000-0000-4000-8000-000000000004',
      name: null,
      sku: null,
      barcode: null,
      sale_price_minor: 1200,
      standard_cost_minor: 0,
      sort_order: 1,
    },
  ];
  return payload;
}

function productPayloadWithCreationDependency(
  categoryId: string,
): Record<string, unknown> {
  const payload = productPayload(categoryId);
  payload.dependencies = [
    {
      ref_type: 'category',
      ref_id: categoryId,
      depends_on_event_id: '00000000-0000-4000-8000-000000000011',
    },
  ];
  return payload;
}

function category(): CategoryEntity {
  return Object.assign(new CategoryEntity(), {
    id: '00000000-0000-4000-8000-000000000010',
    version: 1,
    createdEventId: '00000000-0000-4000-8000-000000000011',
    lastEventId: '00000000-0000-4000-8000-000000000011',
    lastServerSequence: '10',
  });
}

function kilogramUnit(overrides: Partial<UnitEntity> = {}): UnitEntity {
  return Object.assign(new UnitEntity(), {
    unitId: '00000000-0000-4000-8000-000000000020',
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

function pieceUnit(): UnitEntity {
  return kilogramUnit({
    unitId: '00000000-0000-4000-8000-000000000040',
    code: 'piece',
    name: 'Pieza',
    symbol: 'pz',
    dimension: 'count',
    atomicFactor: '1',
    maxFractionDigits: 0,
  });
}

function inventoryItem(
  overrides: Partial<InventoryItemEntity> = {},
): InventoryItemEntity {
  return Object.assign(new InventoryItemEntity(), {
    id: '00000000-0000-4000-8000-000000000030',
    defaultUnitId: '00000000-0000-4000-8000-000000000040',
    name: 'Café americano',
    active: true,
    createdEventId: '00000000-0000-4000-8000-000000000031',
    lastEventId: '00000000-0000-4000-8000-000000000031',
    lastServerSequence: '10',
    ...overrides,
  });
}

function inventoryCreationEvent(): EventEntity {
  return Object.assign(new EventEntity(), {
    eventId: '00000000-0000-4000-8000-000000000031',
    eventType: 'recurso_inventario_creado',
    aggregateType: 'inventory_item',
    aggregateId: '00000000-0000-4000-8000-000000000030',
    syncStatus: EventSyncStatus.SYNCED,
  });
}

function managerFixture(
  options: {
    category?: CategoryEntity;
    baseEvent?: EventEntity;
    baseEventRef?: EventRefEntity;
    unit?: UnitEntity;
    inventoryItem?: InventoryItemEntity;
    product?: ProductEntity;
    variant?: ProductVariantEntity;
    variants?: ProductVariantEntity[];
    existingEvent?: EventEntity;
  } = {},
): {
  manager: EntityManager;
  created: Array<{
    target: EntityTarget<unknown>;
    value: Record<string, unknown>;
  }>;
} {
  const created: Array<{
    target: EntityTarget<unknown>;
    value: Record<string, unknown>;
  }> = [];
  let sequence = 10;
  const manager = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(
      (
        target: EntityTarget<unknown>,
        findOptions?: { where?: Record<string, unknown> },
      ): Promise<unknown> => {
        if (target === CategoryEntity) {
          return Promise.resolve(options.category ?? null);
        }
        if (target === UnitEntity) return Promise.resolve(options.unit ?? null);
        if (target === InventoryItemEntity) {
          return Promise.resolve(options.inventoryItem ?? null);
        }
        if (target === ProductEntity) {
          return Promise.resolve(options.product ?? null);
        }
        if (target === ProductVariantEntity) {
          const variants = [
            ...(options.variant ? [options.variant] : []),
            ...(options.variants ?? []),
          ];
          const where = findOptions?.where;
          return Promise.resolve(
            variants.find(
              (variant) =>
                (where?.id === undefined || variant.id === where.id) &&
                (where?.productId === undefined ||
                  variant.productId === where.productId) &&
                (where?.nameKey === undefined ||
                  variant.nameKey === where.nameKey) &&
                (where?.inventoryItemId === undefined ||
                  variant.inventoryItemId === where.inventoryItemId),
            ) ?? null,
          );
        }
        return Promise.resolve(null);
      },
    ),
    findOneBy: jest.fn(
      (
        target: EntityTarget<unknown>,
        where: Record<string, unknown>,
      ): Promise<unknown> => {
        if (
          target === EventEntity &&
          where.eventId === options.existingEvent?.eventId
        ) {
          return Promise.resolve(options.existingEvent);
        }
        if (
          target === EventEntity &&
          where.eventId === options.baseEvent?.eventId
        ) {
          return Promise.resolve(options.baseEvent);
        }
        if (
          target === EventRefEntity &&
          where.eventId === options.baseEventRef?.eventId &&
          where.refType === options.baseEventRef.refType &&
          where.refId === options.baseEventRef.refId &&
          where.relationship === options.baseEventRef.relationship
        ) {
          return Promise.resolve(options.baseEventRef);
        }
        if (target === ProductVariantEntity && typeof where.id === 'string') {
          const variants = [
            ...(options.variant ? [options.variant] : []),
            ...(options.variants ?? []),
          ];
          return Promise.resolve(
            variants.find((variant) => variant.id === where.id) ?? null,
          );
        }
        if (
          target === ProductVariantEntity &&
          typeof where.inventoryItemId === 'string'
        ) {
          const variants = [
            ...(options.variant ? [options.variant] : []),
            ...(options.variants ?? []),
          ];
          return Promise.resolve(
            variants.find(
              (variant) => variant.inventoryItemId === where.inventoryItemId,
            ) ?? null,
          );
        }
        return Promise.resolve(null);
      },
    ),
    create: jest.fn(
      (target: EntityTarget<unknown>, value: Record<string, unknown>) => {
        const entity = { ...value };
        if (target === EventEntity) {
          sequence += 1;
          entity.serverSequence = String(sequence);
          entity.createdAtServer = new Date('2026-08-05T20:31:00.000Z');
        }
        created.push({ target, value: entity });
        return entity;
      },
    ),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
  } as unknown as EntityManager;
  return { manager, created };
}
