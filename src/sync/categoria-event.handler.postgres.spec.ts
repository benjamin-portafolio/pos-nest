import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { UnitEntity } from '../entities/unit.entity';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { CategoryEntity } from '../entities/category.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { ProductEntity } from '../entities/product.entity';
import type { PushEventDto } from './dto/push-events.dto';
import { CategoriaEventHandler } from './categoria-event.handler';
import type { SyncConflictService } from './sync-conflict.service';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration('CategoriaEventHandler con PostgreSQL real', () => {
  jest.setTimeout(30_000);

  const schema = `categoria_delete_it_${process.pid}_${Date.now()}`;
  let administration: DataSource;
  let database: DataSource;

  beforeAll(async () => {
    const connection = postgresConnectionOptions();
    administration = new DataSource(connection);
    await administration.initialize();
    await administration.query(`CREATE SCHEMA "${schema}"`);

    database = new DataSource({
      ...connection,
      schema,
      entities: [
        UnitEntity,
        InventoryItemEntity,
        CategoryEntity,
        ProductEntity,
        EventEntity,
        EventRefEntity,
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

  it('mantiene la FK de products.category_id con RESTRICT', async () => {
    const source = category({ sortOrder: 0 });
    const product = linkedProduct(source.id);
    await database.manager.save(source);
    await database.manager.save(product);

    await expect(
      database.transaction(async (manager) => {
        const locked = await manager.findOneByOrFail(CategoryEntity, {
          id: source.id,
        });
        await manager.remove(locked);
      }),
    ).rejects.toThrow(/violates.*constraint|violates restrict constraint/i);

    expect(
      await database.manager.findOneBy(CategoryEntity, { id: source.id }),
    ).not.toBeNull();
    await database.manager.remove(product);
    await database.manager.remove(source);
  });

  it('revierte productos, categoría, orden, evento y refs ante un fallo intermedio', async () => {
    const source = category({ sortOrder: 0 });
    const destination = category({ sortOrder: 1 });
    const products = [linkedProduct(source.id), linkedProduct(source.id)];
    await database.manager.save([source, destination]);
    await database.manager.save(products);

    await database.query(`
      CREATE FUNCTION "${schema}".fail_category_compaction()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced category compaction failure';
      END;
      $$
    `);
    await database.query(`
      CREATE TRIGGER fail_category_compaction
      BEFORE UPDATE ON "${schema}"."categories"
      FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_category_compaction()
    `);

    const deletion = deleteEvent(source, destination, products);
    const handler = new CategoriaEventHandler({
      recordConflict: jest.fn(
        (_manager: unknown, options: { reason: string }) => {
          throw new Error(options.reason);
        },
      ),
    } as unknown as SyncConflictService);
    await expect(
      database.transaction((manager) => handler.apply(manager, deletion)),
    ).rejects.toThrow('forced category compaction failure');

    const storedSource = await database.manager.findOneBy(CategoryEntity, {
      id: source.id,
    });
    const storedDestination = await database.manager.findOneBy(CategoryEntity, {
      id: destination.id,
    });
    const storedProducts = await database.manager.find(ProductEntity, {
      order: { id: 'ASC' },
    });
    expect(storedSource).not.toBeNull();
    expect(storedDestination).toEqual(
      expect.objectContaining({ sortOrder: 1, version: 1 }),
    );
    expect(storedProducts).toHaveLength(2);
    expect(
      storedProducts.every((product) => product.categoryId === source.id),
    ).toBe(true);
    expect(await database.manager.count(EventEntity)).toBe(0);
    expect(await database.manager.count(EventRefEntity)).toBe(0);

    await database.query(
      `DROP TRIGGER fail_category_compaction ON "${schema}"."categories"`,
    );
    await database.query(
      `DROP FUNCTION "${schema}".fail_category_compaction()`,
    );
    await database.manager.remove(storedProducts);
    await database.manager.remove([storedSource!, storedDestination!]);
  });

  it('serializa dos operaciones que toman pos.category_order', async () => {
    const first = database.createQueryRunner();
    const second = database.createQueryRunner();
    await first.connect();
    await second.connect();
    await first.startTransaction();
    await second.startTransaction();

    try {
      await first.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        'pos.category_order',
      ]);
      let secondAcquired = false;
      const pending = second
        .query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          'pos.category_order',
        ])
        .then(() => {
          secondAcquired = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(secondAcquired).toBe(false);
      await first.commitTransaction();
      await pending;
      expect(secondAcquired).toBe(true);
    } finally {
      if (first.isTransactionActive) await first.rollbackTransaction();
      if (second.isTransactionActive) await second.rollbackTransaction();
      await first.release();
      await second.release();
    }
  });
});

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

function category({ sortOrder }: { sortOrder: number }): CategoryEntity {
  const baseEventId = randomUUID();
  return Object.assign(new CategoryEntity(), {
    id: randomUUID(),
    name: sortOrder === 0 ? 'Origen' : 'Destino',
    colorKey: 'amber',
    sortOrder,
    active: true,
    version: 1,
    createdEventId: baseEventId,
    lastEventId: baseEventId,
    lastServerSequence: null,
  });
}

function linkedProduct(categoryId: string): ProductEntity {
  const baseEventId = randomUUID();
  return Object.assign(new ProductEntity(), {
    id: randomUUID(),
    name: 'Artículo',
    categoryId,
    active: true,
    version: 1,
    createdEventId: baseEventId,
    lastEventId: baseEventId,
    lastServerSequence: null,
  });
}

function deleteEvent(
  source: CategoryEntity,
  destination: CategoryEntity,
  products: ProductEntity[],
): PushEventDto {
  const eventId = randomUUID();
  const sortedProducts = [...products].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  return {
    event_id: eventId,
    aggregate_type: 'category',
    aggregate_id: source.id,
    event_type: 'categoria_eliminada',
    device_id: 'postgres_integration_device',
    user_id: 'postgres_integration_user',
    local_sequence: 1,
    base_server_sequence: null,
    base_version: source.version,
    created_at_local: new Date().toISOString(),
    payload: {
      base_event_id: source.lastEventId,
      deleted_category: {
        name: source.name,
        color_key: source.colorKey,
        sort_order: source.sortOrder,
        active: source.active,
        created_event_id: source.createdEventId,
      },
      product_resolution: {
        type: 'move',
        destination_category: {
          category_id: destination.id,
          base_event_id: destination.lastEventId,
          base_version: destination.version,
          base_server_sequence: null,
        },
      },
      linked_products: sortedProducts.map((product) => ({
        product_id: product.id,
        base_event_id: product.lastEventId,
        base_version: product.version,
        base_server_sequence: null,
        category_id: { from: source.id, to: destination.id },
      })),
      shifted_categories: [
        {
          category_id: destination.id,
          base_event_id: destination.lastEventId,
          base_version: destination.version,
          base_server_sequence: null,
          sort_order: { from: 1, to: 0 },
        },
      ],
    },
  };
}
