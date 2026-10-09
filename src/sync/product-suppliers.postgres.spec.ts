import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { SupplierEntity } from '../entities/supplier.entity';
import { VariantSupplierEntity } from '../entities/variant-supplier.entity';
import { ProductEntity } from '../entities/product.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { CategoryEntity } from '../entities/category.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { UnitEntity } from '../entities/unit.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { RecipeComponentEntity } from '../entities/recipe-component.entity';
import { VariantInventoryMemoryEntity } from '../entities/variant-inventory-memory.entity';
import { ClienteEntity } from '../entities/cliente.entity';
import { SaleEntity } from '../entities/sale.entity';
import { SaleItemEntity } from '../entities/sale-item.entity';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { SyncConflictParticipantEntity } from '../entities/sync-conflict-participant.entity';
import { CreateProductSuppliers1791417600000 } from '../migrations/1791417600000-CreateProductSuppliers';
import { EventsGateway } from '../events/events.gateway';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { supplierFixture } from '../testing/supplier-contract-fixtures';
import { PushEventDto } from './dto/push-events.dto';
import { ProductoEventHandler } from './producto-event.handler';
import { ProveedorEventHandler } from './proveedor-event.handler';
import { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';

const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
const supplier1 = '00000000-0000-4000-8000-000000000002';
const supplier2 = '00000000-0000-4000-8000-000000000003';
const creation1 = '00000000-0000-4000-8000-000000000004';
const productCreation = '00000000-0000-4000-8000-000000000005';
const variant1 = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000007';
integration(
  'Proveedores/productos: PostgreSQL, atomicidad y sync existente',
  () => {
    jest.setTimeout(30_000);
    const schema = `suppliers_it_${process.pid}_${Date.now()}`;
    let admin: DataSource, db: DataSource, service: SyncService;
    const conflicts = new SyncConflictService();
    const supplierHandler = new ProveedorEventHandler(conflicts);
    const productHandler = new ProductoEventHandler(conflicts);
    const notify = jest.fn();
    let sequence = 0;
    beforeAll(async () => {
      const connection = {
        type: 'postgres' as const,
        host: process.env.DATABASE_HOST,
        port: Number(process.env.DATABASE_PORT),
        username: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
        database: process.env.DATABASE_NAME,
      };
      admin = new DataSource(connection);
      await admin.initialize();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      db = new DataSource({
        ...connection,
        schema,
        extra: { options: `-c search_path=${schema},public` },
        synchronize: true,
        entities: [
          SupplierEntity,
          VariantSupplierEntity,
          ProductEntity,
          ProductVariantEntity,
          CategoryEntity,
          EventEntity,
          EventRefEntity,
          UnitEntity,
          InventoryItemEntity,
          InventoryBalanceEntity,
          InventoryMovementEntity,
          RecipeComponentEntity,
          VariantInventoryMemoryEntity,
          ClienteEntity,
          SaleEntity,
          SaleItemEntity,
          SalePaymentEntity,
          SyncConflictEntity,
          SyncConflictParticipantEntity,
        ],
      });
      await db.initialize();
      // Cada prueba usa las tablas creadas por la migración real, con metadatos TypeORM.
      const runner = db.createQueryRunner();
      try {
        const migration = new CreateProductSuppliers1791417600000();
        await migration.down(runner);
        await migration.up(runner);
      } finally {
        await runner.release();
      }
      service = new SyncService(
        db,
        { notifyEventsAvailable: notify } as unknown as EventsGateway,
        conflicts,
        undefined,
        productHandler,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        supplierHandler,
      );
    });
    afterAll(async () => {
      if (db?.isInitialized) await db.destroy();
      if (admin?.isInitialized) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      }
    });
    beforeEach(async () => {
      await db.query(
        'TRUNCATE variant_suppliers, suppliers, recipe_components, product_variants, products, inventory_items, units, events, event_refs, sync_conflicts, sync_conflict_participants RESTART IDENTITY CASCADE',
      );
      sequence = 0;
      notify.mockClear();
    });
    function event(
      type: string,
      id: string,
      payload: Record<string, unknown>,
      overrides: Partial<PushEventDto> = {},
    ): PushEventDto {
      return {
        event_id: randomUUID(),
        event_type: type,
        aggregate_type: type.startsWith('proveedor_') ? 'supplier' : 'product',
        aggregate_id: id,
        device_id: 'tablet',
        user_id: 'user',
        local_sequence: ++sequence,
        base_version: 1,
        base_server_sequence: null,
        created_at_local: '2026-10-08T12:00:00.000Z',
        payload,
        ...overrides,
      };
    }
    async function push(e: PushEventDto) {
      return (await service.pushEvents({ device_id: e.device_id, events: [e] }))
        .results[0];
    }
    async function acceptedPayload(id: string): Promise<Record<string, any>> {
      const e = await db.manager.findOneByOrFail(EventEntity, { eventId: id });
      return structuredClone(
        e.eventType === 'producto_actualizado'
          ? (e.payload.after as Record<string, unknown>)
          : e.payload,
      );
    }
    async function seedSuppliers() {
      const e = event(
        'proveedor_creado',
        supplier1,
        supplierFixture('proveedor_creado'),
        { event_id: creation1 },
      );
      const other = event(
        'proveedor_creado',
        supplier2,
        supplierFixture('proveedor_creado'),
      );
      expect((await push(e)).status).toBe('accepted');
      expect((await push(other)).status).toBe('accepted');
      return { e, other };
    }
    async function createProduct(
      fixture = 'producto_creado',
      mutate?: (json: Record<string, any>) => void,
    ) {
      const json = supplierFixture(fixture);
      mutate?.(json);
      const e = event('producto_creado', productId, json, {
        event_id: productCreation,
      });
      expect((await push(e)).status).toBe('accepted');
      return e;
    }
    async function updateProduct(
      base: PushEventDto,
      mutate: (json: Record<string, any>) => void,
      overrides: Partial<PushEventDto> = {},
    ) {
      const before = await acceptedPayload(base.event_id),
        after = structuredClone(before);
      mutate(after);
      const row = await db.manager.findOneByOrFail(ProductEntity, {
        id: base.aggregate_id,
      });
      return event(
        'producto_actualizado',
        base.aggregate_id,
        { base_event_id: base.event_id, before, after },
        {
          base_version: row.version,
          base_server_sequence: row.lastServerSequence,
          ...overrides,
        },
      );
    }
    async function supplierUpdate(
      base: PushEventDto,
      after: Record<string, unknown> = {
        name: 'Norte editada',
        phone: '00123',
        notes: null,
      },
    ) {
      const row = await db.manager.findOneByOrFail(SupplierEntity, {
        id: base.aggregate_id,
      });
      return event(
        'proveedor_actualizado',
        base.aggregate_id,
        {
          base_event_id: base.event_id,
          before: (
            await db.manager.findOneByOrFail(EventEntity, {
              eventId: base.event_id,
            })
          ).payload,
          after,
        },
        {
          base_version: row.version,
          base_server_sequence: row.lastServerSequence,
        },
      );
    }
    async function snapshot() {
      return Promise.all(
        [
          EventEntity,
          EventRefEntity,
          SupplierEntity,
          VariantSupplierEntity,
          ProductEntity,
          ProductVariantEntity,
          RecipeComponentEntity,
          InventoryItemEntity,
          InventoryBalanceEntity,
          InventoryMovementEntity,
          VariantInventoryMemoryEntity,
        ].map((entity) => db.manager.find(entity as typeof EventEntity)),
      );
    }
    it('alta/edición canónicas, refs, deduplicación después de editar y pull aceptado', async () => {
      const e = event('proveedor_creado', supplier1, {
        name: '  Norte ',
        phone: ' 00123 ',
        notes: '  ',
      });
      const first = await push(e);
      expect(first.status).toBe('accepted');
      const saved = await db.manager.findOneByOrFail(EventEntity, {
        eventId: e.event_id,
      });
      expect(saved.payload).toEqual({
        name: 'Norte',
        phone: '00123',
        notes: null,
      });
      const edit = await supplierUpdate(e);
      expect((await push(edit)).status).toBe('accepted');
      const beforeRetry = await snapshot();
      expect(await push(e)).toMatchObject({
        status: 'duplicate',
        original_sync_status: 'synced',
        server_sequence: first.server_sequence,
      });
      expect((await push(edit)).status).toBe('duplicate');
      expect(await snapshot()).toEqual(beforeRetry);
      expect(
        await db.manager.findOneByOrFail(SupplierEntity, { id: supplier1 }),
      ).toMatchObject({
        version: 2,
        createdEventId: e.event_id,
        lastEventId: edit.event_id,
        name: 'Norte editada',
        phone: '00123',
        notes: null,
      });
      expect(await db.manager.find(EventRefEntity)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            refType: 'supplier',
            refId: supplier1,
            relationship: 'affects',
          }),
        ]),
      );
      const pulled = await service.pullEvents({ since: 0 });
      expect(pulled.events.map((e) => e.event_id)).toEqual([
        e.event_id,
        edit.event_id,
      ]);
      expect(notify).toHaveBeenCalledTimes(2);
    });
    it('idempotencia concurrente del alta, sin duplicar refs ni versiones', async () => {
      const e = event(
        'proveedor_creado',
        supplier1,
        supplierFixture('proveedor_creado'),
      );
      const results = await Promise.all([push(e), push(e)]);
      expect(results.map((r) => r.status).sort()).toEqual([
        'accepted',
        'duplicate',
      ]);
      expect(await db.manager.count(SupplierEntity)).toBe(1);
      expect(await db.manager.count(EventRefEntity)).toBe(1);
    });
    it('dos altas distintas de misma identidad producen un conflicto oficial', async () => {
      const a = event('proveedor_creado', supplier1, { name: 'Norte' }),
        b = event('proveedor_creado', supplier1, { name: 'Sur' });
      const results = await Promise.all([push(a), push(b)]);
      expect(results.map((r) => r.status).sort()).toEqual([
        'accepted',
        'conflict',
      ]);
      expect(await db.manager.count(SupplierEntity)).toBe(1);
      expect(await db.manager.count(SyncConflictEntity)).toBe(1);
      expect(await db.manager.count(SyncConflictParticipantEntity)).toBe(2);
    });
    it('ediciones concurrentes de proveedor tienen un ganador por base', async () => {
      const { e } = await seedSuppliers();
      const a = await supplierUpdate(e),
        b = await supplierUpdate(e, { name: 'Sur' });
      expect(
        (await Promise.all([push(a), push(b)])).map((r) => r.status).sort(),
      ).toEqual(['accepted', 'conflict']);
      expect(
        (await db.manager.findOneByOrFail(SupplierEntity, { id: supplier1 }))
          .version,
      ).toBe(2);
    });
    for (const change of [
      'version',
      'base-event',
      'sequence',
      'before',
      'missing',
    ])
      it(`proveedor rechaza base ${change} sin alterar catálogo`, async () => {
        const { e } = await seedSuppliers();
        const edit = await supplierUpdate(e);
        if (change === 'version') edit.base_version = 2;
        if (change === 'base-event') edit.payload.base_event_id = randomUUID();
        if (change === 'sequence') edit.base_server_sequence = 0;
        if (change === 'before')
          (edit.payload.before as Record<string, unknown>).notes = 'Inventadas';
        if (change === 'missing') edit.aggregate_id = randomUUID();
        const before = await db.manager.find(SupplierEntity);
        expect((await push(edit)).status).toBe('conflict');
        expect(await db.manager.find(SupplierEntity)).toEqual(before);
      });
    for (const change of [
      'identity',
      'date',
      'local-sequence',
      'version',
      'cursor',
      'aggregate',
    ])
      it(`sobre proveedor inválido ${change} da rechazo funcional`, async () => {
        const e = event('proveedor_creado', supplier1, { name: 'Norte' });
        if (change === 'identity') e.event_id = 'bad';
        if (change === 'date') e.created_at_local = 'bad';
        if (change === 'local-sequence')
          e.local_sequence = Number.MAX_SAFE_INTEGER;
        if (change === 'version') e.base_version = 1.5;
        if (change === 'cursor')
          e.base_server_sequence = Number.MAX_SAFE_INTEGER + 1;
        if (change === 'aggregate') e.aggregate_type = 'product';
        expect((await push(e)).status).toBe('rejected');
        expect(await db.manager.count(SupplierEntity)).toBe(0);
      });
    it('payload rechazado se deduplica y no entra a pull; no permite reutilizar ID con otro contenido', async () => {
      const e = event('proveedor_creado', supplier1, { name: ' ' });
      expect((await push(e)).status).toBe('rejected');
      expect((await push(e)).status).toBe('duplicate');
      expect((await push({ ...e, payload: { name: 'Nuevo' } })).status).toBe(
        'rejected',
      );
      expect((await service.pullEvents({ since: 0 })).events).toEqual([]);
      expect(await db.manager.count(SupplierEntity)).toBe(0);
    });
    it('colisión device/local_sequence revierte el intento completo y devuelve rechazo', async () => {
      const { e } = await seedSuppliers();
      const collision = event(
        'proveedor_creado',
        randomUUID(),
        { name: 'Tercero' },
        { local_sequence: e.local_sequence },
      );
      expect((await push(collision)).status).toBe('rejected');
      expect(await db.manager.count(SupplierEntity)).toBe(2);
      expect(
        await db.manager.countBy(EventEntity, { eventId: collision.event_id }),
      ).toBe(0);
    });
    it('fallo tras alta/edición/refs revierte todos los datos', async () => {
      const e = event('proveedor_creado', supplier1, { name: 'Norte' });
      const empty = await snapshot();
      await expect(
        db.transaction(async (m) => {
          expect((await supplierHandler.apply(m, e)).status).toBe('accepted');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await snapshot()).toEqual(empty);
      expect((await push(e)).status).toBe('accepted');
      const edit = await supplierUpdate(e),
        before = await snapshot();
      await expect(
        db.transaction(async (m) => {
          expect((await supplierHandler.apply(m, edit)).status).toBe(
            'accepted',
          );
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await snapshot()).toEqual(before);
    });
    it('varias variantes/proveedores, compartido, cero y máximo bigint; editar otros campos conserva precios', async () => {
      await seedSuppliers();
      const create = await createProduct('producto_creado', (json) => {
        json.variants[0].suppliers[1].quoted_price_minor =
          Number.MAX_SAFE_INTEGER;
        json.variants[0].suppliers[1].quoted_at_ms = Number.MAX_SAFE_INTEGER;
        json.variants.push({
          ...structuredClone(json.variants[0]),
          variant_id: randomUUID(),
          name: 'Grande',
          sort_order: 1,
        });
      });
      const relations = await db.manager.find(VariantSupplierEntity);
      expect(relations).toHaveLength(4);
      expect(relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ quotedPriceMinor: '0' }),
          expect.objectContaining({
            quotedAtMs: '9007199254740991',
            quotedPriceMinor: '9007199254740991',
          }),
        ]),
      );
      const edit = await updateProduct(create, (json) => {
        json.product.name = 'Nuevo nombre';
        json.variants[0].sale_price_minor = 999;
        json.variants[0].standard_cost_minor = 123;
      });
      expect((await push(edit)).status).toBe('accepted');
      expect(await db.manager.find(VariantSupplierEntity)).toEqual(relations);
      const beforeRetry = await snapshot();
      expect((await push(create)).status).toBe('duplicate');
      expect((await push(edit)).status).toBe('duplicate');
      expect(await snapshot()).toEqual(beforeRetry);
      expect(
        (
          await push({
            ...create,
            payload: supplierFixture('producto_sin_proveedores'),
          })
        ).status,
      ).toBe('rejected');
    });
    it('producto medido con receta mantiene base, receta, costo e inventario al cambiar precio de proveedor', async () => {
      await seedSuppliers();
      const unitId = '10000000-0000-4000-8000-000000000003',
        itemId = '00000000-0000-4000-8000-000000000006';
      await db.manager.insert(UnitEntity, {
        unitId,
        code: 'kg',
        name: 'Kilogramo',
        symbol: 'kg',
        dimension: 'mass',
        atomicFactor: '1000',
        maxFractionDigits: 3,
        active: true,
      });
      await db.manager.insert(InventoryItemEntity, {
        id: itemId,
        name: 'Café',
        defaultUnitId: unitId,
        active: true,
        version: 1,
      });
      await db.manager.insert(InventoryBalanceEntity, {
        inventoryItemId: itemId,
        quantityOnHandAtomic: '2000',
        quantityAvailableAtomic: '2000',
        lastEventId: randomUUID(),
      });
      const create = await createProduct('producto_medido_con_receta');
      const before = await Promise.all([
        db.manager.find(RecipeComponentEntity),
        db.manager.find(InventoryItemEntity),
        db.manager.find(InventoryBalanceEntity),
      ]);
      const edit = await updateProduct(create, (json) => {
        json.variants[0].suppliers[0].quoted_price_minor = 1;
        json.variants[0].suppliers[0].quoted_at_ms = Number.MAX_SAFE_INTEGER;
      });
      expect((await push(edit)).status).toBe('accepted');
      expect(
        await Promise.all([
          db.manager.find(RecipeComponentEntity),
          db.manager.find(InventoryItemEntity),
          db.manager.find(InventoryBalanceEntity),
        ]),
      ).toEqual(before);
      expect(
        await db.manager.findOneByOrFail(ProductVariantEntity, {
          id: variant1,
        }),
      ).toMatchObject({ salePriceMinor: '2500', standardCostMinor: null });
    });
    it('rollback tras proyectar producto/variantes/recetas/precios/evento/refs restaura snapshot', async () => {
      await seedSuppliers();
      const create = await createProduct();
      const before = await snapshot();
      const edit = await updateProduct(create, (json) => {
        json.product.name = 'Temporal';
        json.variants[0].suppliers[0].quoted_price_minor = 100;
      });
      await expect(
        db.transaction(async (m) => {
          expect((await productHandler.apply(m, edit)).status).toBe('accepted');
          expect(
            await m.findOneByOrFail(VariantSupplierEntity, {
              variantId: variant1,
              supplierId: supplier1,
            }),
          ).toMatchObject({ quotedPriceMinor: '100' });
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await snapshot()).toEqual(before);
      expect((await push(edit)).status).toBe('accepted');
    });
    for (const change of [
      'missing-row',
      'missing-event',
      'other-supplier',
      'update-event',
      'not-accepted',
      'other-creation',
    ])
      it(`dependencia de producto ${change} sin proyección parcial`, async () => {
        const { e, other } = await seedSuppliers();
        const json = supplierFixture('producto_creado');
        if (change === 'missing-row')
          await db.manager.delete(SupplierEntity, { id: supplier1 });
        if (change === 'missing-event')
          json.dependencies[0].depends_on_event_id = randomUUID();
        if (change === 'other-supplier')
          json.dependencies[0].depends_on_event_id = other.event_id;
        if (change === 'update-event') {
          const edit = await supplierUpdate(e);
          expect((await push(edit)).status).toBe('accepted');
          json.dependencies[0].depends_on_event_id = edit.event_id;
        }
        if (change === 'not-accepted') {
          const conflict = event('proveedor_creado', supplier1, {
            name: 'Otra',
          });
          expect((await push(conflict)).status).toBe('conflict');
          json.dependencies[0].depends_on_event_id = conflict.event_id;
        }
        if (change === 'other-creation') {
          const fake = event('proveedor_creado', supplier1, { name: 'Otra' });
          await db.manager.save(EventEntity, {
            eventId: fake.event_id,
            aggregateId: supplier1,
            aggregateType: 'supplier',
            eventType: fake.event_type,
            deviceId: 'synthetic',
            userId: 'user',
            createdAtLocal: new Date(fake.created_at_local),
            payload: fake.payload,
            syncStatus: EventSyncStatus.SYNCED,
          });
          json.dependencies[0].depends_on_event_id = fake.event_id;
        }
        const result = await push(event('producto_creado', productId, json));
        expect(result.status).toBe(
          ['other-supplier', 'update-event', 'other-creation'].includes(change)
            ? 'rejected'
            : 'conflict',
        );
        expect(await db.manager.count(ProductEntity)).toBe(0);
        expect(await db.manager.count(ProductVariantEntity)).toBe(0);
        expect(await db.manager.count(VariantSupplierEntity)).toBe(0);
      });
    it('proveedor confirmado sin dependencia causal y alta editada siguen siendo utilizables', async () => {
      const { e } = await seedSuppliers();
      expect((await push(await supplierUpdate(e))).status).toBe('accepted');
      await createProduct('producto_creado', (json) => {
        delete json.dependencies[0].depends_on_event_id;
      });
      expect(await db.manager.count(VariantSupplierEntity)).toBe(2);
    });
    it('retirar último proveedor guarda [] y refs de ambos conjuntos retirados, sin borrar catálogo', async () => {
      await seedSuppliers();
      const create = await createProduct();
      const edit = await updateProduct(create, (json) => {
        json.variants[0].suppliers = [];
        json.dependencies = [];
      });
      expect((await push(edit)).status).toBe('accepted');
      expect(await db.manager.count(VariantSupplierEntity)).toBe(0);
      expect(await db.manager.count(SupplierEntity)).toBe(2);
      const refs = await db.manager.findBy(EventRefEntity, {
        eventId: edit.event_id,
      });
      expect(
        refs
          .filter((r) => r.refType === 'supplier')
          .map((r) => r.refId)
          .sort(),
      ).toEqual([supplier1, supplier2]);
      expect(
        refs.filter((r) => r.refType === 'variant_suppliers'),
      ).toHaveLength(1);
      const after = await acceptedPayload(edit.event_id);
      expect(after.variants[0].suppliers).toEqual([]);
      const preflight = await service.preflightEvents({
        device_id: 'other',
        last_full_pull_server_sequence: 0,
        pending_refs: [
          {
            event_id: randomUUID(),
            event_type: 'producto_actualizado',
            aggregate_type: 'product',
            aggregate_id: productId,
            ref_type: 'variant_suppliers',
            ref_id: variant1,
            relationship: 'affects',
          },
        ],
      });
      expect(preflight.events.map((e) => e.event_id)).toContain(edit.event_id);
    });
    it('quitar variante conserva precios inactivos; borrado físico aplica CASCADE y deja proveedor', async () => {
      await seedSuppliers();
      let second = '';
      const create = await createProduct('producto_creado', (json) => {
        second = randomUUID();
        json.variants.push({
          ...structuredClone(json.variants[0]),
          variant_id: second,
          sort_order: 1,
        });
      });
      const edit = await updateProduct(create, (json) => {
        json.variants.pop();
      });
      expect((await push(edit)).status).toBe('accepted');
      expect(
        (await db.manager.findOneByOrFail(ProductVariantEntity, { id: second }))
          .active,
      ).toBe(false);
      expect(
        await db.manager.countBy(VariantSupplierEntity, { variantId: second }),
      ).toBe(2);
      expect(
        await db.manager.findBy(EventRefEntity, {
          eventId: edit.event_id,
          refType: 'variant_suppliers',
          refId: second,
        }),
      ).toHaveLength(1);
      await db.manager.delete(ProductVariantEntity, { id: second });
      expect(
        await db.manager.countBy(VariantSupplierEntity, { variantId: second }),
      ).toBe(0);
      expect(await db.manager.count(SupplierEntity)).toBe(2);
    });
    it('borrado lógico conserva precios históricos, incluye refs inactivas y replay no resucita', async () => {
      await seedSuppliers();
      let inactive = '';
      const create = await createProduct('producto_creado', (json) => {
        inactive = randomUUID();
        json.variants.push({
          ...structuredClone(json.variants[0]),
          variant_id: inactive,
          sort_order: 1,
        });
      });
      const remove = await updateProduct(create, (json) => {
        json.variants.pop();
      });
      expect((await push(remove)).status).toBe('accepted');
      const deletion = await updateProduct(remove, () => {});
      deletion.payload.after = null;
      deletion.payload.delete_product = true;
      expect((await push(deletion)).status).toBe('accepted');
      expect(await db.manager.count(VariantSupplierEntity)).toBe(4);
      expect(
        (await db.manager.findOneByOrFail(ProductEntity, { id: productId }))
          .active,
      ).toBe(false);
      expect(
        await db.manager.findBy(EventRefEntity, {
          eventId: deletion.event_id,
          refType: 'variant_suppliers',
        }),
      ).toHaveLength(2);
      expect((await push(create)).status).toBe('duplicate');
      expect((await push(deletion)).status).toBe('duplicate');
      await db.manager.delete(ProductEntity, { id: productId });
      expect(await db.manager.count(VariantSupplierEntity)).toBe(0);
      expect((await push(create)).status).toBe('duplicate');
      expect(await db.manager.count(ProductEntity)).toBe(0);
    });
    it('replay legado mantiene omisión; promoción exacta before vacío agrega precios explícitos', async () => {
      await seedSuppliers();
      const create = await createProduct('producto_legado');
      expect(
        (await acceptedPayload(create.event_id)).variants[0],
      ).not.toHaveProperty('suppliers');
      const legacy = await updateProduct(create, (json) => {
        json.product.name = 'Legado editado';
      });
      expect((await push(legacy)).status).toBe('accepted');
      expect(
        (await acceptedPayload(legacy.event_id)).variants[0],
      ).not.toHaveProperty('suppliers');
      const known = await updateProduct(legacy, (json) => {
        json.variants[0].suppliers =
          supplierFixture('producto_creado').variants[0].suppliers;
        json.dependencies = supplierFixture('producto_creado').dependencies;
      });
      (known.payload.before as Record<string, any>).variants[0].suppliers = [];
      expect((await push(known)).status).toBe('accepted');
      expect(await db.manager.count(VariantSupplierEntity)).toBe(2);
    });
    it('promoción no inventa una base no vacía y rechaza pérdida de conocimiento con []', async () => {
      await seedSuppliers();
      const create = await createProduct('producto_legado');
      const invented = await updateProduct(create, (json) => {
        json.variants[0].suppliers =
          supplierFixture('producto_creado').variants[0].suppliers;
        json.dependencies = supplierFixture('producto_creado').dependencies;
      });
      (invented.payload.before as Record<string, any>).variants[0].suppliers =
        supplierFixture('producto_creado').variants[0].suppliers;
      (invented.payload.before as Record<string, any>).dependencies =
        supplierFixture('producto_creado').dependencies;
      expect((await push(invented)).status).toBe('rejected');
      expect(await db.manager.count(VariantSupplierEntity)).toBe(0);
      const promote = await updateProduct(create, (json) => {
        json.variants[0].suppliers = [];
      });
      (promote.payload.before as Record<string, any>).variants[0].suppliers =
        [];
      expect((await push(promote)).status).toBe('accepted');
      const old = await updateProduct(promote, (json) => {
        delete json.variants[0].suppliers;
      });
      delete (old.payload.before as Record<string, any>).variants[0].suppliers;
      expect((await push(old)).status).toBe('rejected');
      expect(
        (await acceptedPayload(promote.event_id)).variants[0].suppliers,
      ).toEqual([]);
    });
    it('parser antiguo que descarta suppliers en before/after no puede borrar precios conocidos', async () => {
      await seedSuppliers();
      const create = await createProduct();
      const before = await db.manager.find(VariantSupplierEntity);
      const old = await updateProduct(create, (json) => {
        delete json.variants[0].suppliers;
        json.dependencies = [];
        json.product.name = 'Viejo';
      });
      delete (old.payload.before as Record<string, any>).variants[0].suppliers;
      (old.payload.before as Record<string, any>).dependencies = [];
      expect((await push(old)).status).toBe('rejected');
      expect(await db.manager.find(VariantSupplierEntity)).toEqual(before);
    });
    it('before compara precios/fechas y protege evento/versión/secuencia base', async () => {
      await seedSuppliers();
      const create = await createProduct();
      const relations = await db.manager.find(VariantSupplierEntity);
      for (const field of ['quoted_price_minor', 'quoted_at_ms']) {
        const edit = await updateProduct(create, () => {});
        (edit.payload.before as Record<string, any>).variants[0].suppliers[0][
          field
        ]++;
        expect((await push(edit)).status).toBe('rejected');
      }
      for (const overrides of [
        { base_version: 2 },
        { base_server_sequence: 0 },
      ]) {
        const edit = await updateProduct(create, () => {}, overrides);
        expect(['conflict', 'rejected']).toContain((await push(edit)).status);
      }
      const edit = await updateProduct(create, () => {});
      edit.payload.base_event_id = randomUUID();
      expect((await push(edit)).status).toBe('conflict');
      expect(await db.manager.find(VariantSupplierEntity)).toEqual(relations);
    });
    it('dos precios concurrentes de proveedores distintos compiten por el producto completo', async () => {
      await seedSuppliers();
      const create = await createProduct();
      const a = await updateProduct(create, (json) => {
        json.variants[0].suppliers[0].quoted_price_minor = 42;
        json.variants[0].suppliers[0].quoted_at_ms = Number.MAX_SAFE_INTEGER;
      });
      const b = await updateProduct(create, (json) => {
        json.variants[0].suppliers[1].quoted_price_minor = 99;
        json.variants[0].suppliers[1].quoted_at_ms = 1;
      });
      const results = await Promise.all([push(a), push(b)]);
      expect(results.map((r) => r.status).sort()).toEqual([
        'accepted',
        'conflict',
      ]);
      const winner = results[0].status === 'accepted' ? a : b;
      expect(
        (await db.manager.findOneByOrFail(ProductEntity, { id: productId }))
          .lastEventId,
      ).toBe(winner.event_id);
      const state = await acceptedPayload(winner.event_id);
      for (const price of state.variants[0].suppliers)
        expect(
          await db.manager.findOneByOrFail(VariantSupplierEntity, {
            variantId: variant1,
            supplierId: price.supplier_id,
          }),
        ).toMatchObject({
          quotedPriceMinor: String(price.quoted_price_minor),
          quotedAtMs: String(price.quoted_at_ms),
        });
    });
    for (const change of [
      'price-string',
      'price-range',
      'date-zero',
      'duplicate',
      'null-set',
    ]) {
      it(`edición inválida ${change} no escribe producto, precios ni refs`, async () => {
        await seedSuppliers();
        const create = await createProduct();
        const oldProduct = await db.manager.find(ProductEntity),
          relations = await db.manager.find(VariantSupplierEntity);
        const edit = await updateProduct(create, (json) => {
          if (change === 'price-string')
            json.variants[0].suppliers[0].quoted_price_minor = '0';
          if (change === 'price-range')
            json.variants[0].suppliers[0].quoted_price_minor =
              Number.MAX_SAFE_INTEGER + 1;
          if (change === 'date-zero')
            json.variants[0].suppliers[0].quoted_at_ms = 0;
          if (change === 'duplicate')
            json.variants[0].suppliers.push(json.variants[0].suppliers[0]);
          if (change === 'null-set') json.variants[0].suppliers = null;
        });
        expect((await push(edit)).status).toBe('rejected');
        expect(await db.manager.find(ProductEntity)).toEqual(oldProduct);
        expect(await db.manager.find(VariantSupplierEntity)).toEqual(relations);
        expect(
          await db.manager.countBy(EventRefEntity, { eventId: edit.event_id }),
        ).toBe(0);
        expect(
          (await service.pullEvents({ since: 0 })).events.map(
            (e) => e.event_id,
          ),
        ).not.toContain(edit.event_id);
      });
    }
    it('retirada no requiere entregar la dependencia histórica de before', async () => {
      await seedSuppliers();
      const create = await createProduct();
      const edit = await updateProduct(create, (json) => {
        json.variants[0].suppliers = [];
        json.dependencies = [];
      });
      (
        edit.payload.before as Record<string, any>
      ).dependencies[0].depends_on_event_id = randomUUID();
      expect((await push(edit)).status).toBe('accepted');
      expect(await db.manager.count(VariantSupplierEntity)).toBe(0);
    });
    it('el alta original sigue siendo dependencia válida después de editar el proveedor', async () => {
      const { e } = await seedSuppliers();
      expect((await push(await supplierUpdate(e))).status).toBe('accepted');
      await createProduct();
      expect(await db.manager.count(VariantSupplierEntity)).toBe(2);
    });
    it('seguimiento directo pasa a receta y luego a ninguno conservando proveedores, fechas y saldo', async () => {
      await seedSuppliers();
      const unitId = randomUUID(),
        itemId = randomUUID();
      await db.manager.insert(UnitEntity, {
        unitId,
        code: 'piece',
        name: 'Pieza',
        symbol: 'pza',
        dimension: 'count',
        atomicFactor: '1',
        maxFractionDigits: 0,
        active: true,
      });
      await db.manager.insert(InventoryItemEntity, {
        id: itemId,
        name: 'Recurso',
        defaultUnitId: unitId,
        active: true,
        version: 1,
      });
      await db.manager.insert(InventoryBalanceEntity, {
        inventoryItemId: itemId,
        quantityOnHandAtomic: '10',
        quantityAvailableAtomic: '10',
        lastEventId: randomUUID(),
      });
      const create = await createProduct('producto_creado', (json) => {
        json.variants[0].inventory_item_id = itemId;
        json.dependencies.push({ ref_type: 'inventory_item', ref_id: itemId });
      });
      const prices = await db.manager.find(VariantSupplierEntity),
        stock = await db.manager.find(InventoryBalanceEntity);
      const recipe = await updateProduct(create, (json) => {
        delete json.variants[0].inventory_item_id;
        json.variants[0].inventory_configuration = {
          enabled: true,
          components: [{ inventory_item_id: itemId, quantity_atomic: 1 }],
        };
      });
      expect((await push(recipe)).status).toBe('accepted');
      expect(await db.manager.count(RecipeComponentEntity)).toBe(1);
      const none = await updateProduct(recipe, (json) => {
        delete json.variants[0].inventory_configuration;
        json.dependencies = json.dependencies.filter(
          (d: Record<string, unknown>) => d.ref_type !== 'inventory_item',
        );
      });
      expect((await push(none)).status).toBe('accepted');
      expect(await db.manager.count(RecipeComponentEntity)).toBe(0);
      expect(await db.manager.find(VariantSupplierEntity)).toEqual(prices);
      expect(await db.manager.find(InventoryBalanceEntity)).toEqual(stock);
      expect(
        await db.manager.findOneByOrFail(VariantInventoryMemoryEntity, {
          variantId: variant1,
        }),
      ).toMatchObject({
        inventoryItemId: itemId,
        sourceEventId: create.event_id,
      });
      expect(await db.manager.count(InventoryMovementEntity)).toBe(0);
    });
  },
);
