import { DataSource } from 'typeorm';
import { CategoryEntity } from '../entities/category.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
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
        EventEntity,
        EventRefEntity,
        CategoryEntity,
        UnitEntity,
        InventoryItemEntity,
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
        isDefault: variant.isDefault,
        sortOrder: variant.sortOrder,
      })),
    ).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000003',
        isDefault: true,
        sortOrder: 0,
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        isDefault: false,
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
        isDefault: true,
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
          is_default: true,
          sort_order: 0,
        },
        {
          variant_id: '00000000-0000-4000-8000-000000000004',
          name: null,
          sku: null,
          barcode: null,
          sale_price_minor: 1200,
          standard_cost_minor: 0,
          is_default: false,
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
          is_default: true,
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
