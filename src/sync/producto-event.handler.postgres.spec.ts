import { ClienteEntity } from '../entities/cliente.entity';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { SaleEntity } from '../entities/sale.entity';
import { SaleItemEntity } from '../entities/sale-item.entity';
import { DataSource } from 'typeorm';
import { CategoryEntity } from '../entities/category.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { ProductEntity } from '../entities/product.entity';
import { RecipeComponentEntity } from '../entities/recipe-component.entity';
import { UnitEntity } from '../entities/unit.entity';
import { SaleMode } from '../enums/sale-mode.enum';
import type { PushEventDto } from './dto/push-events.dto';
import { ProductoEventHandler } from './producto-event.handler';
import type { SyncConflictService } from './sync-conflict.service';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration('ProductoEventHandler con PostgreSQL real', () => {
  jest.setTimeout(30_000);

  const schema = `product_it_${process.pid}_${Date.now()}`;
  let administration: DataSource;
  let database: DataSource;
  const handler = new ProductoEventHandler({
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
        ClienteEntity,
        SaleEntity,
        SaleItemEntity,
        SalePaymentEntity,
        ProductVariantEntity,
        ProductEntity,
        CategoryEntity,
        EventEntity,
        EventRefEntity,
        CategoryEntity,
        UnitEntity,
        InventoryItemEntity,
        InventoryBalanceEntity,
        InventoryMovementEntity,
        ProductEntity,
        ProductVariantEntity,
        RecipeComponentEntity,
      ],
      synchronize: true,
    });
    await database.initialize();
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
        "${schema}"."recipe_components",
        "${schema}"."product_variants",
        "${schema}"."products",
        "${schema}"."inventory_items",
        "${schema}"."units",
        "${schema}"."event_refs",
        "${schema}"."events"
      RESTART IDENTITY CASCADE
    `);
  });

  for (const dependency of ['none', 'inventory', 'recipe']) {
    it(`desactiva producto y variantes históricas con ${dependency} conservando inventario`, async () => {
      const itemId = '00000000-0000-4000-8000-000000000030';
      const unitId = '00000000-0000-4000-8000-000000000020';
      if (dependency !== 'none') {
        await database.manager.save(
          database.manager.create(UnitEntity, {
            unitId,
            code: 'piece',
            name: 'Pieza',
            symbol: 'pza',
            dimension: 'count',
            atomicFactor: '1',
            maxFractionDigits: 0,
            active: true,
          }),
        );
        await database.manager.save(
          database.manager.create(InventoryItemEntity, {
            id: itemId,
            defaultUnitId: unitId,
            name: 'Recurso',
            active: true,
            version: 1,
          }),
        );
        await database.manager.save(InventoryBalanceEntity, {
          inventoryItemId: itemId,
          quantityOnHandAtomic: '50',
          quantityAvailableAtomic: '50',
          lastEventId: '00000000-0000-4000-8000-000000000070',
        });
        await database.manager.save(InventoryMovementEntity, {
          movementId: '00000000-0000-4000-8000-000000000071',
          inventoryItemId: itemId,
          eventId: '00000000-0000-4000-8000-000000000070',
          movementType: 'initial_balance',
          quantityDeltaAtomic: '50',
          createdAtLocal: new Date('2026-09-09T12:00:00Z'),
        });
      }
      const creation = productEvent();
      const values = creation.payload.variants as Array<
        Record<string, unknown>
      >;
      const firstId = values[0].variant_id as string;
      if (dependency === 'inventory') values[0].inventory_item_id = itemId;
      if (dependency === 'recipe')
        values[0].inventory_configuration = {
          enabled: true,
          components: [{ inventory_item_id: itemId, quantity_atomic: 1 }],
        };
      if (dependency !== 'none')
        creation.payload.dependencies = [
          { ref_type: 'inventory_item', ref_id: itemId },
        ];
      expect(
        (await database.transaction((m) => handler.apply(m, creation))).status,
      ).toBe('accepted');
      const before = (
        await database.manager.findOneByOrFail(EventEntity, {
          eventId: creation.event_id,
        })
      ).payload;
      // Borrar directamente las variantes activas y simular un fallo después
      // de la cascada debe restaurar el catálogo y no guardar el evento.
      await expect(
        database.transaction(async (manager) => {
          const result = await handler.apply(manager, {
            ...creation,
            event_id: '00000000-0000-4000-8000-000000000080',
            event_type: 'producto_actualizado',
            local_sequence: 2,
            payload: {
              base_event_id: creation.event_id,
              before,
              after: null,
              delete_product: true,
            },
          });
          expect(result.status).toBe('accepted');
          expect(await manager.countBy(ProductEntity, { active: true })).toBe(
            0,
          );
          expect(
            await manager.countBy(ProductVariantEntity, { active: true }),
          ).toBe(0);
          expect(await manager.count(RecipeComponentEntity)).toBe(
            dependency === 'recipe' ? 1 : 0,
          );
          throw new Error('fallo transaccional simulado');
        }),
      ).rejects.toThrow('fallo transaccional simulado');
      expect(await database.manager.count(ProductVariantEntity)).toBe(2);
      expect(await database.manager.count(RecipeComponentEntity)).toBe(
        dependency === 'recipe' ? 1 : 0,
      );
      expect(await database.manager.count(EventEntity)).toBe(1);
      const after = structuredClone(before);
      after.variants = [(after.variants as Array<Record<string, unknown>>)[1]];
      const kept = (after.variants as Array<Record<string, unknown>>)[0];
      kept.sort_order = 0;
      kept.name = values[0].name;
      after.dependencies = [];
      const update: PushEventDto = {
        ...creation,
        event_id: '00000000-0000-4000-8000-000000000050',
        local_sequence: 2,
        event_type: 'producto_actualizado',
        payload: { base_event_id: creation.event_id, before, after },
      };
      expect(
        (await database.transaction((m) => handler.apply(m, update))).status,
      ).toBe('accepted');
      const removed = await database.manager.findOneBy(ProductVariantEntity, {
        id: firstId,
      });
      expect(removed).not.toBeNull();
      if (removed) {
        expect(removed.active).toBe(false);
        expect(removed.name).toBe(values[0].name);
        expect(removed.inventoryItemId).toBe(
          dependency === 'inventory' ? itemId : null,
        );
      }
      expect(
        await database.manager.countBy(RecipeComponentEntity, {
          variantId: firstId,
        }),
      ).toBe(dependency === 'recipe' ? 1 : 0);
      const active = await database.manager.find(ProductVariantEntity, {
        where: { active: true },
      });
      expect(active).toHaveLength(1);
      expect(
        await database.manager.countBy(EventRefEntity, {
          eventId: update.event_id,
          refId: firstId,
          refType: 'product_variant',
        }),
      ).toBe(1);
      // Same event is idempotent; stale deletion cannot overwrite newer state.
      expect(
        (await database.transaction((m) => handler.apply(m, update))).status,
      ).toBe('accepted');
      const state = (
        await database.manager.findOneByOrFail(EventEntity, {
          eventId: update.event_id,
        })
      ).payload.after;
      const deletion: PushEventDto = {
        ...update,
        event_id: '00000000-0000-4000-8000-000000000051',
        local_sequence: 3,
        base_version: 2,
        payload: {
          base_event_id: update.event_id,
          before: state,
          after: null,
          delete_product: true,
        },
      };
      expect(
        (
          await database.transaction((m) =>
            handler.apply(m, {
              ...deletion,
              event_id: '00000000-0000-4000-8000-000000000052',
              local_sequence: 4,
              base_version: 1,
            }),
          )
        ).status,
      ).toBe('conflict');
      expect(
        (await database.transaction((m) => handler.apply(m, deletion))).status,
      ).toBe('accepted');
      expect(
        (await database.transaction((m) => handler.apply(m, deletion))).status,
      ).toBe('accepted');
      const product = await database.manager.findOneBy(ProductEntity, {
        id: creation.aggregate_id,
      });
      expect(product?.active).toBe(false);
      expect(
        await database.manager.countBy(ProductVariantEntity, { active: true }),
      ).toBe(0);
      expect(await database.manager.count(RecipeComponentEntity)).toBe(
        dependency === 'recipe' ? 1 : 0,
      );
      expect(
        await database.manager.countBy(EventRefEntity, {
          eventId: deletion.event_id,
          refId: firstId,
          refType: 'product_variant',
        }),
      ).toBe(1);
      expect(await database.manager.count(InventoryItemEntity)).toBe(
        dependency === 'none' ? 0 : 1,
      );
      if (dependency !== 'none') {
        expect(
          await database.manager.findOneByOrFail(InventoryBalanceEntity, {
            inventoryItemId: itemId,
          }),
        ).toEqual(
          expect.objectContaining({
            quantityOnHandAtomic: '50',
            quantityAvailableAtomic: '50',
          }),
        );
        expect(await database.manager.find(InventoryMovementEntity)).toEqual([
          expect.objectContaining({
            inventoryItemId: itemId,
            quantityDeltaAtomic: '50',
          }),
        ]);
      }
      // Replaying creation after hard deletion must never resurrect it.
      expect(
        (await database.transaction((m) => handler.apply(m, creation))).status,
      ).toBe('accepted');
      expect(
        await database.manager.countBy(ProductEntity, { active: true }),
      ).toBe(0);
      const reused = {
        ...creation,
        event_id: '00000000-0000-4000-8000-000000000060',
        local_sequence: 5,
      };
      expect(
        (await database.transaction((m) => handler.apply(m, reused))).status,
      ).toBe('conflict');
    });
  }

  it('actualiza precios, costo, nombre y orden sin reemplazar identidades', async () => {
    const creation = productEvent();
    await database.transaction((manager) => handler.apply(manager, creation));
    const before = creation.payload;
    const after = structuredClone(before);
    (after.product as Record<string, unknown>).name = 'Café editado';
    const variants = after.variants as Array<Record<string, unknown>>;
    variants.reverse();
    variants.forEach((v, i) => {
      v.sort_order = i;
      v.name = i === 0 ? 'Grande' : 'Chico';
      v.sale_price_minor = 2500;
      v.standard_cost_minor = null;
    });
    variants.push({
      variant_id: '00000000-0000-4000-8000-000000000080',
      name: 'Nueva',
      sale_price_minor: 2500,
      standard_cost_minor: null,
      sort_order: 2,
    });
    const update = {
      ...creation,
      event_id: '00000000-0000-4000-8000-000000000050',
      event_type: 'producto_actualizado',
      local_sequence: 2,
      payload: { base_event_id: creation.event_id, before, after },
    };
    const result = await database.transaction((manager) =>
      handler.apply(manager, update),
    );
    expect(result.status).toBe('accepted');
    expect(
      (await database.transaction((manager) => handler.apply(manager, update)))
        .status,
    ).toBe('accepted');
    const product = await database.manager.findOneByOrFail(ProductEntity, {
      id: creation.aggregate_id,
    });
    expect(product.name).toBe('Café editado');
    expect(product.version).toBe(2);
    expect(product.createdEventId).toBe(creation.event_id);
    const rows = await database.manager.find(ProductVariantEntity, {
      order: { sortOrder: 'ASC' },
    });
    expect(rows.map((v) => v.id)).toEqual(variants.map((v) => v.variant_id));
    expect(rows.map((v) => v.salePriceMinor)).toEqual(['2500', '2500', '2500']);
    expect(
      rows.every(
        (v) =>
          v.standardCostMinor === null &&
          (v.createdEventId === creation.event_id ||
            v.createdEventId === update.event_id),
      ),
    ).toBe(true);
    const stale = await database.transaction((manager) =>
      handler.apply(manager, {
        ...update,
        event_id: '00000000-0000-4000-8000-000000000051',
        local_sequence: 3,
      }),
    );
    expect(stale.status).toBe('conflict');
    expect(
      (
        await database.manager.findOneByOrFail(ProductEntity, {
          id: product.id,
        })
      ).version,
    ).toBe(2);
  });

  it('rechaza forma de venta adulterada incluso cambiando ambos estados', async () => {
    const creation = productEvent();
    await database.transaction((manager) => handler.apply(manager, creation));
    const changed = structuredClone(creation.payload);
    (changed.product as Record<string, unknown>).sale_configuration = {
      mode: 'measured',
      sale_unit_id: '00000000-0000-4000-8000-000000000060',
      price_reference_quantity_atomic: 1000,
    };
    changed.dependencies = [
      { ref_type: 'unit', ref_id: '00000000-0000-4000-8000-000000000060' },
    ];
    const result = await database.transaction((manager) =>
      handler.apply(manager, {
        ...creation,
        event_id: '00000000-0000-4000-8000-000000000052',
        event_type: 'producto_actualizado',
        local_sequence: 2,
        payload: {
          base_event_id: creation.event_id,
          before: changed,
          after: changed,
        },
      }),
    );
    expect(result.status).toBe('rejected');
    expect(result.reason).toContain('forma de venta');
    expect(
      (
        await database.manager.findOneByOrFail(ProductEntity, {
          id: creation.aggregate_id,
        })
      ).saleMode,
    ).toBe('unit');
  });

  it('persiste el orden de variantes y refs atómica e idempotentemente', async () => {
    const event = productEvent();
    const first = await database.transaction((manager) =>
      handler.apply(manager, event),
    );
    const second = await database.transaction((manager) =>
      handler.apply(manager, event),
    );

    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    expect(await database.manager.count(ProductEntity)).toBe(1);
    expect(await database.manager.count(ProductVariantEntity)).toBe(2);
    const variants = await database.manager.find(ProductVariantEntity, {
      where: { productId: event.aggregate_id },
      order: { sortOrder: 'ASC' },
    });
    expect(
      variants.map((variant) => ({
        id: variant.id,
        sortOrder: variant.sortOrder,
      })),
    ).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000003',
        sortOrder: 0,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        sortOrder: 1,
      },
    ]);
    expect(await database.manager.count(EventEntity)).toBe(1);
    expect(await database.manager.count(EventRefEntity)).toBe(4);
  });

  it('una colisión de la segunda variante no escribe parcialmente', async () => {
    const existingProduct = await database.manager.save(
      database.manager.create(ProductEntity, {
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Existente',
        categoryId: null,
        saleMode: SaleMode.UNIT,
        saleUnitId: null,
        priceReferenceQuantityAtomic: null,
        active: true,
        version: 1,
        createdEventId: '10000000-0000-4000-8000-000000000002',
        lastEventId: '10000000-0000-4000-8000-000000000002',
        lastServerSequence: null,
      }),
    );
    await database.manager.save(
      database.manager.create(ProductVariantEntity, {
        id: '00000000-0000-4000-8000-000000000004',
        productId: existingProduct.id,
        name: null,
        nameKey: null,
        salePriceMinor: '500',
        standardCostMinor: null,
        sortOrder: 0,
        active: true,
        version: 1,
        createdEventId: '10000000-0000-4000-8000-000000000002',
        lastEventId: '10000000-0000-4000-8000-000000000002',
        lastServerSequence: null,
      }),
    );

    const result = await database.transaction((manager) =>
      handler.apply(manager, productEvent()),
    );

    expect(result.status).toBe('conflict');
    expect(
      await database.manager.findOneBy(ProductEntity, {
        id: '00000000-0000-4000-8000-000000000002',
      }),
    ).toBeNull();
    expect(await database.manager.count(ProductVariantEntity)).toBe(1);
  });

  it('persiste una receta y su referencia de inventario atómicamente', async () => {
    await database.manager.save(
      database.manager.create(UnitEntity, {
        unitId: '00000000-0000-4000-8000-000000000020',
        code: 'g',
        name: 'Gramo',
        symbol: 'g',
        dimension: 'mass',
        atomicFactor: '1',
        maxFractionDigits: 0,
        active: true,
      }),
    );
    await database.manager.save(
      database.manager.create(InventoryItemEntity, {
        id: '00000000-0000-4000-8000-000000000030',
        defaultUnitId: '00000000-0000-4000-8000-000000000020',
        name: 'Café molido',
        active: true,
        version: 1,
        createdEventId: '00000000-0000-4000-8000-000000000031',
        lastEventId: '00000000-0000-4000-8000-000000000031',
        lastServerSequence: null,
      }),
    );

    const result = await database.transaction((manager) =>
      handler.apply(manager, recipeProductEvent()),
    );

    expect(result.status).toBe('accepted');
    expect(await database.manager.find(RecipeComponentEntity)).toEqual([
      expect.objectContaining({
        variantId: '00000000-0000-4000-8000-000000000003',
        inventoryItemId: '00000000-0000-4000-8000-000000000030',
        quantityAtomic: '18',
      }),
    ]);
    expect(
      await database.manager.countBy(EventRefEntity, {
        refType: 'recipe',
        refId: '00000000-0000-4000-8000-000000000003',
      }),
    ).toBe(1);
    const saved = await database.manager.findOneByOrFail(EventEntity, {
      eventId: '00000000-0000-4000-8000-000000000011',
    });
    expect(
      (saved.payload.variants as Array<Record<string, unknown>>)[0]
        .inventory_configuration,
    ).toEqual({
      enabled: true,
      components: [
        {
          inventory_item_id: '00000000-0000-4000-8000-000000000030',
          quantity_atomic: 18,
        },
      ],
    });
    const creation = recipeProductEvent();
    const after = structuredClone(creation.payload);
    const value = (after.variants as Array<Record<string, unknown>>)[0];
    value.inventory_configuration = {
      enabled: true,
      components: [
        {
          inventory_item_id: '00000000-0000-4000-8000-000000000030',
          quantity_atomic: 25,
        },
      ],
    };
    const update = {
      ...creation,
      event_id: '00000000-0000-4000-8000-000000000071',
      event_type: 'producto_actualizado',
      local_sequence: 2,
      payload: {
        base_event_id: creation.event_id,
        before: creation.payload,
        after,
      },
    };
    expect(
      (await database.transaction((manager) => handler.apply(manager, update)))
        .status,
    ).toBe('accepted');
    expect(
      (await database.manager.find(RecipeComponentEntity))[0].quantityAtomic,
    ).toBe('25');
    const cleared = structuredClone(after);
    delete (cleared.variants as Array<Record<string, unknown>>)[0]
      .inventory_configuration;
    cleared.dependencies = [];
    expect(
      (
        await database.transaction((manager) =>
          handler.apply(manager, {
            ...update,
            event_id: '00000000-0000-4000-8000-000000000072',
            local_sequence: 3,
            base_version: 2,
            payload: {
              base_event_id: update.event_id,
              before: after,
              after: cleared,
            },
          }),
        )
      ).status,
    ).toBe('accepted');
    expect(await database.manager.count(RecipeComponentEntity)).toBe(0);
    expect(await database.manager.count(InventoryItemEntity)).toBe(1);
  });
});

function productEvent(): PushEventDto {
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
    created_at_local: '2026-08-25T12:00:00.000Z',
    payload: {
      product: {
        name: 'Café',
        category_id: null,
        sale_configuration: { mode: 'unit' },
      },
      variants: [
        {
          variant_id: '00000000-0000-4000-8000-000000000003',
          name: 'Grande',
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
      ],
      dependencies: [],
    },
  };
}

function recipeProductEvent(): PushEventDto {
  return {
    ...productEvent(),
    event_id: '00000000-0000-4000-8000-000000000011',
    payload: {
      product: {
        name: 'Café preparado',
        category_id: null,
        sale_configuration: { mode: 'unit' },
      },
      variants: [
        {
          variant_id: '00000000-0000-4000-8000-000000000003',
          name: null,
          sku: null,
          barcode: null,
          sale_price_minor: 4500,
          standard_cost_minor: 900,
          inventory_configuration: {
            enabled: true,
            components: [
              {
                inventory_item_id: '00000000-0000-4000-8000-000000000030',
                quantity_atomic: 18,
              },
            ],
          },
          sort_order: 0,
        },
      ],
      dependencies: [
        {
          ref_type: 'inventory_item',
          ref_id: '00000000-0000-4000-8000-000000000030',
        },
      ],
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
