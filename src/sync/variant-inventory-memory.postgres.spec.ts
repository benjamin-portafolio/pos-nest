import { DataSource } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { ProductEntity } from '../entities/product.entity';
import { RecipeComponentEntity } from '../entities/recipe-component.entity';
import { VariantInventoryMemoryEntity } from '../entities/variant-inventory-memory.entity';
import { SaleMode } from '../enums/sale-mode.enum';
import type { EventsGateway } from '../events/events.gateway';
import {
  applySharedRecipeResource,
  seedSharedDirectLink,
  seedVariantTrackingUnits,
  VARIANT_TRACKING,
  VARIANT_TRACKING_LOCAL,
  variantTrackingEvent,
} from '../testing/variant-tracking-scenario';
import type { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { InventoryEventHandler } from './inventory-event.handler';
import { ProductoEventHandler } from './producto-event.handler';
import { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

/**
 * Memoria de variante con PostgreSQL real (contrato rev. 1 §5.2 y §7).
 *
 * Todos los eventos de producto se aplican con `ProductoEventHandler` dentro de
 * una transacción real: la memoria se mantiene bajo el lock de producto que ya
 * serializa la configuración, y estas pruebas no pueden pasar si esa escritura
 * se hiciera fuera del lock o fuera de la transacción.
 *
 * Los eventos locales se construyen con estado y sobres explícitos porque el
 * contrato obliga a encadenarlos: cada `producto_actualizado` declara el estado
 * persistido anterior en `before`, y la comparación es exacta. Los fixtures del
 * escenario compartido se aplican tal cual, sin reescribir su sobre.
 */
runPostgresIntegration('Memoria de variante con PostgreSQL real', () => {
  jest.setTimeout(30_000);

  const schema = `variant_mem_it_${process.pid}_${Date.now()}`;
  let administration: DataSource;
  let database: DataSource;
  let secuencia = 0;
  const recordConflict = jest.fn().mockResolvedValue({
    conflictId: '90000000-0000-4000-8000-0000000000ff',
  });
  const conflicts = {
    recordConflict,
  } as unknown as SyncConflictService;
  const inventory = new InventoryEventHandler(conflicts);
  const productos = new ProductoEventHandler(conflicts);

  beforeAll(async () => {
    const connection = postgresConnectionOptions();
    administration = new DataSource(connection);
    await administration.initialize();
    await administration.query(`CREATE SCHEMA "${schema}"`);
    database = new DataSource({
      ...connection,
      schema,
      // Todas las entidades: las relaciones entre recursos y ventas cierran el
      // grafo, y el esquema aislado debe coincidir con el de la aplicación.
      entities: [__dirname + '/../entities/*.entity.ts'],
      synchronize: true,
    });
    await database.initialize();
    await seedVariantTrackingUnits(database);
  });

  afterAll(async () => {
    if (database?.isInitialized) await database.destroy();
    if (administration?.isInitialized) {
      await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
      await administration.destroy();
    }
  });

  beforeEach(async () => {
    secuencia = 0;
    recordConflict.mockClear();
    await database.query(`
      TRUNCATE TABLE
        "${schema}"."recipe_components",
        "${schema}"."variant_inventory_memory",
        "${schema}"."product_variants",
        "${schema}"."products",
        "${schema}"."inventory_movements",
        "${schema}"."inventory_balances",
        "${schema}"."inventory_items",
        "${schema}"."event_refs",
        "${schema}"."events"
      RESTART IDENTITY CASCADE
    `);
  });

  it('acredita la memoria y conserva la procedencia al vincular por primera vez', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });

    const resultado = await aplicarProductos(creacion);

    expect(resultado.status).toBe('accepted');
    expect(await memorias()).toEqual([
      {
        variantId: VARIANTE_PIEZAS,
        inventoryItemId: RECURSO_PIEZAS,
        sourceEventId: creacion.event_id,
        sourceServerSequence: await secuenciaDe(creacion.event_id),
      },
    ]);
    // La procedencia la establece el alta y el producto no la reescribe.
    expect(
      (
        await database.manager.findOneByOrFail(InventoryItemEntity, {
          id: RECURSO_PIEZAS,
        })
      ).originVariantId,
    ).toBe(VARIANTE_PIEZAS);
  });

  it('no mueve la memoria al cambiar el nombre ni al pasar a receta', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    await alta({
      eventId: EV_ALTA_EN_MASA,
      inventoryItemId: RECURSO_EN_MASA,
      name: 'Café en grano',
      unitId: UNIDAD_GRAMO,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const acreditada = (await memorias())[0];

    const renombrado = eventoActualizacion({
      eventId: EV_RENOMBRE,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({
        name: 'Café molido premium',
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });

    const resultadoRenombre = await aplicarProductos(renombrado);

    expect(resultadoRenombre.status).toBe('accepted');
    expect(await memorias()).toEqual([acreditada]);

    const conReceta = eventoActualizacion({
      eventId: EV_RECETA,
      productId: PRODUCTO_PIEZAS,
      baseEventId: renombrado.event_id,
      baseVersion: 2,
      before: await estadoPersistido(renombrado.event_id),
      after: estadoProducto({
        name: 'Café molido premium',
        variants: [
          {
            id: VARIANTE_PIEZAS,
            recipe: [
              { inventoryItemId: RECURSO_EN_MASA, quantityAtomic: 1000 },
            ],
          },
        ],
      }),
    });

    const resultadoReceta = await aplicarProductos(conReceta);

    expect(resultadoReceta.status).toBe('accepted');
    expect(await memorias()).toEqual([acreditada]);
    expect(
      await database.manager.find(RecipeComponentEntity, {
        where: { variantId: VARIANTE_PIEZAS },
      }),
    ).toHaveLength(1);
    expect(
      (
        await database.manager.findOneByOrFail(ProductVariantEntity, {
          id: VARIANTE_PIEZAS,
        })
      ).inventoryItemId,
    ).toBeNull();
  });

  it('asegura la memoria del vínculo anterior al desvincular sin reacreditarla', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const desvincula = eventoActualizacion({
      eventId: EV_DESVINCULA,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({ variants: [{ id: VARIANTE_PIEZAS }] }),
    });

    const resultado = await aplicarProductos(desvincula);

    expect(resultado.status).toBe('accepted');
    const memoria = (await memorias())[0];
    expect(memoria).toEqual({
      variantId: VARIANTE_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      sourceEventId: creacion.event_id,
      sourceServerSequence: await secuenciaDe(creacion.event_id),
    });
    // El vínculo operativo se libera; recurso, saldo e historial sobreviven.
    expect(
      (
        await database.manager.findOneByOrFail(ProductVariantEntity, {
          id: VARIANTE_PIEZAS,
        })
      ).inventoryItemId,
    ).toBeNull();
    expect(
      await database.manager.findOneByOrFail(InventoryBalanceEntity, {
        inventoryItemId: RECURSO_PIEZAS,
      }),
    ).toEqual(
      expect.objectContaining({
        quantityOnHandAtomic: '250',
        quantityAvailableAtomic: '250',
      }),
    );
    expect(await database.manager.count(InventoryMovementEntity)).toBe(1);
    expect(await database.manager.count(InventoryItemEntity)).toBe(1);
  });

  it('reconstruye la memoria ausente desde la configuración acreditada por el evento', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);

    // Borra solo la proyección: la configuración sigue declarando el vínculo.
    await database.manager.delete(VariantInventoryMemoryEntity, {
      variantId: VARIANTE_PIEZAS,
    });

    const renombrado = eventoActualizacion({
      eventId: EV_RENOMBRE,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({
        name: 'Café molido premium',
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    const resultadoRenombre = await aplicarProductos(renombrado);

    expect(resultadoRenombre.status).toBe('accepted');
    expect(await memorias()).toEqual([
      {
        variantId: VARIANTE_PIEZAS,
        inventoryItemId: RECURSO_PIEZAS,
        sourceEventId: renombrado.event_id,
        sourceServerSequence: await secuenciaDe(renombrado.event_id),
      },
    ]);

    // Y también cuando la fila falta justo en la desvinculación: la evidencia
    // es el vínculo persistido, no el `before` que propone el cliente.
    await database.manager.delete(VariantInventoryMemoryEntity, {
      variantId: VARIANTE_PIEZAS,
    });
    const desvincula = eventoActualizacion({
      eventId: EV_DESVINCULA,
      productId: PRODUCTO_PIEZAS,
      baseEventId: renombrado.event_id,
      baseVersion: 2,
      before: await estadoPersistido(renombrado.event_id),
      after: estadoProducto({
        name: 'Café molido premium',
        variants: [{ id: VARIANTE_PIEZAS }],
      }),
    });
    const resultadoDesvincula = await aplicarProductos(desvincula);

    expect(resultadoDesvincula.status).toBe('accepted');
    expect(await memorias()).toEqual([
      {
        variantId: VARIANTE_PIEZAS,
        inventoryItemId: RECURSO_PIEZAS,
        sourceEventId: desvincula.event_id,
        sourceServerSequence: await secuenciaDe(desvincula.event_id),
      },
    ]);
  });

  it('acepta la recuperación del mismo recurso y deja la fila intacta', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const desvincula = eventoActualizacion({
      eventId: EV_DESVINCULA,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({ variants: [{ id: VARIANTE_PIEZAS }] }),
    });
    await aplicarProductos(desvincula);
    const alDesvincular = (await memorias())[0];

    const recupera = eventoActualizacion({
      eventId: EV_RECUPERA,
      productId: PRODUCTO_PIEZAS,
      baseEventId: desvincula.event_id,
      baseVersion: 2,
      before: await estadoPersistido(desvincula.event_id),
      after: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });

    const resultado = await aplicarProductos(recupera);

    expect(resultado.status).toBe('accepted');
    // Mismo recurso recordado: la fila se conserva intacta, sin reacreditar.
    expect(await memorias()).toEqual([alDesvincular]);
    expect(
      (
        await database.manager.findOneByOrFail(ProductVariantEntity, {
          id: VARIANTE_PIEZAS,
        })
      ).inventoryItemId,
    ).toBe(RECURSO_PIEZAS);
    // La recuperación no crea recurso, saldo ni movimiento nuevos.
    expect(await database.manager.count(InventoryItemEntity)).toBe(1);
    expect(await database.manager.count(InventoryBalanceEntity)).toBe(1);
    expect(await database.manager.count(InventoryMovementEntity)).toBe(1);
  });

  it('reutiliza el mismo recurso al volver de receta a directo (SEG-19)', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const acreditada = (await memorias())[0];

    // La receta usa el mismo recurso que antes era vínculo directo.
    const conReceta = eventoActualizacion({
      eventId: EV_RECETA,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({
        variants: [
          {
            id: VARIANTE_PIEZAS,
            recipe: [{ inventoryItemId: RECURSO_PIEZAS, quantityAtomic: 1 }],
          },
        ],
      }),
    });
    expect((await aplicarProductos(conReceta)).status).toBe('accepted');

    const vuelveADirecto = eventoActualizacion({
      eventId: EV_VUELVE_DIRECTO,
      productId: PRODUCTO_PIEZAS,
      baseEventId: conReceta.event_id,
      baseVersion: 2,
      before: await estadoPersistido(conReceta.event_id),
      after: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });

    const resultado = await aplicarProductos(vuelveADirecto);

    expect(resultado.status).toBe('accepted');
    // El mismo identificador de recurso y la misma memoria: la ida y vuelta no
    // genera una existencia nueva ni replaces la fila.
    expect(await memorias()).toEqual([acreditada]);
    expect(
      (
        await database.manager.findOneByOrFail(ProductVariantEntity, {
          id: VARIANTE_PIEZAS,
        })
      ).inventoryItemId,
    ).toBe(RECURSO_PIEZAS);
    // Al volver a directo desaparecen los componentes de la receta.
    expect(
      await database.manager.find(RecipeComponentEntity, {
        where: { variantId: VARIANTE_PIEZAS },
      }),
    ).toHaveLength(0);
    expect(await database.manager.count(InventoryItemEntity)).toBe(1);
    expect(await database.manager.count(InventoryBalanceEntity)).toBe(1);
    expect(await database.manager.count(InventoryMovementEntity)).toBe(1);
  });

  it('sustituye el recurso recordado cuando el vínculo cambia a otro', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    await alta({
      eventId: EV_ALTA_LIBRE,
      inventoryItemId: RECURSO_LIBRE,
      name: 'Café molido 250 g (segunda terminal)',
      unitId: UNIDAD_PIEZA,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const revincula = eventoActualizacion({
      eventId: EV_REVINCULA_OTRO,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_LIBRE }],
      }),
    });

    const resultado = await aplicarProductos(revincula);

    expect(resultado.status).toBe('accepted');
    expect(await memorias()).toEqual([
      {
        variantId: VARIANTE_PIEZAS,
        inventoryItemId: RECURSO_LIBRE,
        sourceEventId: revincula.event_id,
        sourceServerSequence: await secuenciaDe(revincula.event_id),
      },
    ]);
    // El recurso anterior conserva saldo e historial: la memoria no lo borra.
    expect(await database.manager.count(InventoryItemEntity)).toBe(2);
    expect(
      await database.manager.findOneByOrFail(InventoryBalanceEntity, {
        inventoryItemId: RECURSO_PIEZAS,
      }),
    ).toEqual(expect.objectContaining({ quantityOnHandAtomic: '250' }));
  });

  it('es idempotente al repetir la creación y la desvinculación', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const desvincula = eventoActualizacion({
      eventId: EV_DESVINCULA,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({ variants: [{ id: VARIANTE_PIEZAS }] }),
    });

    const primera = await aplicarProductos(desvincula);
    const segunda = await aplicarProductos(desvincula);

    expect(primera.status).toBe('accepted');
    expect(segunda.status).toBe('accepted');
    expect(await memorias()).toHaveLength(1);
    // El alta del recurso, la creación y la desvinculación: el replay no
    // agrega eventos ni movimientos.
    expect(await database.manager.count(EventEntity)).toBe(3);
    expect(await database.manager.count(ProductVariantEntity)).toBe(1);
    expect(await database.manager.count(InventoryMovementEntity)).toBe(1);
  });

  it('no retrocede la memoria con un eco de base vieja', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    await alta({
      eventId: EV_ALTA_LIBRE,
      inventoryItemId: RECURSO_LIBRE,
      name: 'Café molido 250 g (segunda terminal)',
      unitId: UNIDAD_PIEZA,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const revincula = eventoActualizacion({
      eventId: EV_REVINCULA_OTRO,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_LIBRE }],
      }),
    });
    await aplicarProductos(revincula);
    const acreditada = (await memorias())[0];

    const eco = eventoActualizacion({
      eventId: EV_ECO_VIEJO,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: estadoProducto({
        name: 'Café molido de otra terminal',
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    const resultado = await aplicarProductos(eco);

    expect(resultado.status).toBe('conflict');
    expect(await memorias()).toEqual([acreditada]);
  });

  it('conserva vínculo y memoria al desactivar el producto', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const acreditada = (await memorias())[0];
    const desactiva = eventoActualizacion({
      eventId: EV_DESVINCULA,
      productId: PRODUCTO_PIEZAS,
      baseEventId: creacion.event_id,
      baseVersion: 1,
      before: await estadoPersistido(creacion.event_id),
      after: null,
      deleteProduct: true,
    });

    const resultado = await aplicarProductos(desactiva);

    expect(resultado.status).toBe('accepted');
    expect(await memorias()).toEqual([acreditada]);
    const variante = await database.manager.findOneByOrFail(
      ProductVariantEntity,
      { id: VARIANTE_PIEZAS },
    );
    expect(variante.inventoryItemId).toBe(RECURSO_PIEZAS);
    expect(variante.active).toBe(false);
  });

  it('rechaza vincular un recurso generado para otra variante', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PROCEDENCIA,
    });
    const resultado = await aplicarProductos(
      eventoCreacion({
        eventId: EV_PRODUCTO_PIEZAS,
        productId: PRODUCTO_PIEZAS,
        state: estadoProducto({
          variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
        }),
      }),
    );

    expect(resultado.status).toBe('rejected');
    expect(resultado.reason).toContain('generado para la variante');
    expect(await memorias()).toEqual([]);
    expect(
      await database.manager.findOneBy(ProductEntity, { id: PRODUCTO_PIEZAS }),
    ).toBeNull();
  });

  it('acepta un recurso de procedencia desconocida', async () => {
    await alta({
      eventId: EV_ALTA_LIBRE,
      inventoryItemId: RECURSO_LIBRE,
      name: 'Vela aromática',
      unitId: UNIDAD_PIEZA,
    });

    const resultado = await aplicarProductos(
      eventoCreacion({
        eventId: EV_PRODUCTO_PIEZAS,
        productId: PRODUCTO_PIEZAS,
        state: estadoProducto({
          variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_LIBRE }],
        }),
      }),
    );

    expect(resultado.status).toBe('accepted');
    expect((await memorias())[0]).toEqual({
      variantId: VARIANTE_PIEZAS,
      inventoryItemId: RECURSO_LIBRE,
      sourceEventId: EV_PRODUCTO_PIEZAS,
      sourceServerSequence: await secuenciaDe(EV_PRODUCTO_PIEZAS),
    });
    expect(
      (
        await database.manager.findOneByOrFail(InventoryItemEntity, {
          id: RECURSO_LIBRE,
        })
      ).originVariantId,
    ).toBeNull();
  });

  it('rechaza un recurso inactivo', async () => {
    await alta({
      eventId: EV_ALTA_INACTIVO,
      inventoryItemId: RECURSO_INACTIVO,
      name: 'Café molido 250 g (retirado)',
      unitId: UNIDAD_PIEZA,
    });
    await database.manager.update(
      InventoryItemEntity,
      { id: RECURSO_INACTIVO },
      { active: false },
    );

    const resultado = await aplicarProductos(
      eventoCreacion({
        eventId: EV_PRODUCTO_AJENO,
        productId: PRODUCTO_AJENO,
        state: estadoProducto({
          name: 'Café molido retirado',
          variants: [{ id: VARIANTE_AJENA, inventoryItemId: RECURSO_INACTIVO }],
        }),
      }),
    );

    expect(resultado.status).toBe('conflict');
    expect(resultado.reason).toContain('No existe el recurso de inventario');
    expect(await memorias()).toEqual([]);
    expect(
      await database.manager.findOneBy(ProductEntity, { id: PRODUCTO_AJENO }),
    ).toBeNull();
  });

  it('rechaza un recurso ya vinculado a otra variante', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    await aplicarProductos(
      eventoCreacion({
        eventId: EV_PRODUCTO_PIEZAS,
        productId: PRODUCTO_PIEZAS,
        state: estadoProducto({
          variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
        }),
      }),
    );
    const acreditada = (await memorias())[0];

    const resultado = await aplicarProductos(
      eventoCreacion({
        eventId: EV_PRODUCTO_AJENO,
        productId: PRODUCTO_AJENO,
        state: estadoProducto({
          name: 'Café molido de otra terminal',
          variants: [{ id: VARIANTE_AJENA, inventoryItemId: RECURSO_PIEZAS }],
        }),
      }),
    );

    expect(resultado.status).toBe('conflict');
    expect(resultado.reason).toContain('ya pertenece a otra variante');
    expect(await memorias()).toEqual([acreditada]);
    expect(
      await database.manager.findOneBy(ProductEntity, { id: PRODUCTO_AJENO }),
    ).toBeNull();
  });

  it('rechaza una unidad de inventario incompatible con la forma de venta', async () => {
    await alta({
      eventId: EV_ALTA_EN_MASA,
      inventoryItemId: RECURSO_EN_MASA,
      name: 'Café en grano',
      unitId: UNIDAD_GRAMO,
    });

    const resultado = await aplicarProductos(
      eventoCreacion({
        eventId: EV_PRODUCTO_AJENO,
        productId: PRODUCTO_AJENO,
        state: estadoProducto({
          name: 'Café molido por piezas',
          variants: [{ id: VARIANTE_AJENA, inventoryItemId: RECURSO_EN_MASA }],
        }),
      }),
    );

    expect(resultado.status).toBe('rejected');
    expect(resultado.reason).toContain('requiere seguimiento');
    expect(await memorias()).toEqual([]);
    expect(
      await database.manager.findOneBy(ProductEntity, { id: PRODUCTO_AJENO }),
    ).toBeNull();
  });

  it('convierte una carrera por el mismo producto en conflicto, no en error', async () => {
    await alta({
      eventId: EV_ALTA_PIEZAS,
      inventoryItemId: RECURSO_PIEZAS,
      name: 'Café molido 250 g',
      unitId: UNIDAD_PIEZA,
      originVariantId: VARIANTE_PIEZAS,
    });
    await alta({
      eventId: EV_ALTA_LIBRE,
      inventoryItemId: RECURSO_LIBRE,
      name: 'Café molido 250 g (segunda terminal)',
      unitId: UNIDAD_PIEZA,
    });
    const creacion = eventoCreacion({
      eventId: EV_PRODUCTO_PIEZAS,
      productId: PRODUCTO_PIEZAS,
      state: estadoProducto({
        variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS }],
      }),
    });
    await aplicarProductos(creacion);
    const before = await estadoPersistido(creacion.event_id);

    const [uno, otro] = await Promise.all([
      aplicarProductos(
        eventoActualizacion({
          eventId: EV_REVINCULA_OTRO,
          productId: PRODUCTO_PIEZAS,
          baseEventId: creacion.event_id,
          baseVersion: 1,
          before,
          after: estadoProducto({
            variants: [{ id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_LIBRE }],
          }),
        }),
      ),
      aplicarProductos(
        eventoActualizacion({
          eventId: EV_ECO_VIEJO,
          productId: PRODUCTO_PIEZAS,
          baseEventId: creacion.event_id,
          baseVersion: 1,
          before,
          after: estadoProducto({
            name: 'Café molido de otra terminal',
            variants: [
              { id: VARIANTE_PIEZAS, inventoryItemId: RECURSO_PIEZAS },
            ],
          }),
        }),
      ),
    ]);

    expect([uno.status, otro.status].sort()).toEqual(['accepted', 'conflict']);
    // La memoria refleja exactamente al ganador: nunca una mezcla.
    const memoria = (await memorias())[0];
    if (uno.status === 'accepted') {
      expect(memoria.inventoryItemId).toBe(RECURSO_LIBRE);
      expect(memoria.sourceEventId).toBe(uno.event_id);
    } else {
      expect(memoria.inventoryItemId).toBe(RECURSO_PIEZAS);
      expect(memoria.sourceEventId).toBe(creacion.event_id);
    }
  });

  it('acredita la memoria del fixture de desvinculación del escenario compartido', async () => {
    await seedSharedDirectLink(database, inventory);

    const resultado = await aplicarProductos(
      variantTrackingEvent('producto/producto-directo-a-ninguno.json'),
    );

    expect(resultado.status).toBe('accepted');
    expect(await memorias()).toEqual([
      {
        variantId: VARIANT_TRACKING.variante250g,
        inventoryItemId: VARIANT_TRACKING.recursoMolido,
        sourceEventId: VARIANT_TRACKING.evProductoDesvincula,
        sourceServerSequence: await secuenciaDe(
          VARIANT_TRACKING.evProductoDesvincula,
        ),
      },
    ]);
    // El recurso, su saldo y su historial sobreviven: en `server_sync` no se purga.
    expect(
      await database.manager.findOneByOrFail(InventoryBalanceEntity, {
        inventoryItemId: VARIANT_TRACKING.recursoMolido,
      }),
    ).toEqual(
      expect.objectContaining({
        quantityOnHandAtomic: '250',
        quantityAvailableAtomic: '250',
      }),
    );
    expect(
      await database.manager.countBy(InventoryMovementEntity, {
        inventoryItemId: VARIANT_TRACKING.recursoMolido,
      }),
    ).toBe(1);
  });

  it('no cambia el recurso recordado al pasar a receta con el escenario compartido', async () => {
    await seedSharedDirectLink(database, inventory);
    const desvincula = variantTrackingEvent(
      'producto/producto-directo-a-ninguno.json',
    );
    expect((await aplicarProductos(desvincula)).status).toBe('accepted');
    const acreditada = (await memorias())[0];
    await applySharedRecipeResource(database, inventory);

    const receta = await aplicarProductos(
      variantTrackingEvent('producto/producto-directo-a-receta.json'),
    );

    expect(receta.status).toBe('accepted');
    expect(await memorias()).toEqual([acreditada]);
    expect(
      await database.manager.find(RecipeComponentEntity, {
        where: { variantId: VARIANT_TRACKING.variante250g },
      }),
    ).toHaveLength(1);
  });

  it('rechaza el descarte por push sin borrar nada ni distribuirlo', async () => {
    await seedSharedDirectLink(database, inventory);
    expect(
      (
        await aplicarProductos(
          variantTrackingEvent('producto/producto-directo-a-ninguno.json'),
        )
      ).status,
    ).toBe('accepted');
    const acreditada = (await memorias())[0];
    const eventosAntes = await database.manager.count(EventEntity);
    const notificar = jest.fn();
    const servicio = new SyncService(
      database,
      { notifyEventsAvailable: notificar } as unknown as EventsGateway,
      conflicts,
    );
    const descarte = variantTrackingEvent(
      'descarte/sobre-descarte-valido.json',
    );

    const respuesta = await servicio.pushEvents({
      device_id: descarte.device_id,
      events: [descarte],
    });

    expect(respuesta.results[0]?.status).toBe('rejected');
    expect(respuesta.results[0]?.reason).toContain('descarte local');
    // Nada se borra: recurso, saldo, historial y memoria siguen iguales.
    expect(await memorias()).toEqual([acreditada]);
    expect(await database.manager.count(InventoryItemEntity)).toBe(1);
    expect(await database.manager.count(InventoryBalanceEntity)).toBe(1);
    expect(await database.manager.count(InventoryMovementEntity)).toBe(1);
    // Nada se persiste, así que el descarte tampoco se distribuye por pull.
    expect(await database.manager.count(EventEntity)).toBe(eventosAntes);
    const pull = await servicio.pullEvents({ since: 0 });
    expect(pull.events.map((event) => event.event_id)).not.toContain(
      VARIANT_TRACKING.evDescarte,
    );
    expect(notificar).not.toHaveBeenCalled();
  });

  interface VarianteEstado {
    id: string;
    inventoryItemId?: string | null;
    recipe?: Array<{ inventoryItemId: string; quantityAtomic: number }>;
  }

  /**
   * Estado de configuración en la forma del payload. Las dependencias de
   * inventario se derivan de los vínculos y componentes declarados, como exige
   * el contrato: la lista debe coincidir exactamente con los recursos en uso.
   */
  function estadoProducto(options: {
    name?: string;
    variants: VarianteEstado[];
  }): Record<string, unknown> {
    const declarados = [
      ...new Set(
        options.variants.flatMap((variant) => [
          ...(variant.inventoryItemId ? [variant.inventoryItemId] : []),
          ...(variant.recipe ?? []).map((c) => c.inventoryItemId),
        ]),
      ),
    ].sort();
    return {
      product: {
        name: options.name ?? 'Café molido',
        category_id: null,
        sale_configuration: { mode: SaleMode.UNIT },
      },
      variants: options.variants.map((variant, index) => ({
        variant_id: variant.id,
        name: '250 g',
        sku: null,
        barcode: null,
        sale_price_minor: 4500,
        standard_cost_minor: 1800,
        ...(variant.inventoryItemId
          ? { inventory_item_id: variant.inventoryItemId }
          : {}),
        ...(variant.recipe?.length
          ? {
              inventory_configuration: {
                enabled: true,
                components: variant.recipe.map((component) => ({
                  inventory_item_id: component.inventoryItemId,
                  quantity_atomic: component.quantityAtomic,
                })),
              },
            }
          : {}),
        sort_order: index,
      })),
      dependencies: declarados.map((inventoryItemId) => ({
        ref_type: 'inventory_item',
        ref_id: inventoryItemId,
        depends_on_event_id: altaDe(inventoryItemId),
      })),
    };
  }

  function altaDe(inventoryItemId: string): string | null {
    return (
      {
        [RECURSO_PIEZAS]: EV_ALTA_PIEZAS,
        [RECURSO_LIBRE]: EV_ALTA_LIBRE,
        [RECURSO_EN_MASA]: EV_ALTA_EN_MASA,
        [RECURSO_INACTIVO]: EV_ALTA_INACTIVO,
      }[inventoryItemId] ?? null
    );
  }

  /**
   * Sobre local con su propia `local_sequence`: el índice único es por
   * `(device_id, local_sequence)` y estos eventos no comparten dispositivo con
   * los fixtures del escenario compartido.
   */
  function sobreBase(options: {
    eventId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }): PushEventDto {
    return {
      event_id: options.eventId,
      aggregate_type: options.aggregateType,
      aggregate_id: options.aggregateId,
      event_type: options.eventType,
      device_id: DISPOSITIVO_LOCAL,
      user_id: 'usuario-inventario',
      local_sequence: (secuencia += 1),
      base_server_sequence: null,
      base_version: 1,
      created_at_local: CREADO_EN_LOCAL,
      payload: options.payload,
    };
  }

  function eventoCreacion(options: {
    eventId: string;
    productId: string;
    state: Record<string, unknown>;
  }): PushEventDto {
    return sobreBase({
      eventId: options.eventId,
      aggregateType: 'product',
      aggregateId: options.productId,
      eventType: 'producto_creado',
      payload: options.state,
    });
  }

  function eventoActualizacion(options: {
    eventId: string;
    productId: string;
    baseEventId: string;
    baseVersion: number;
    before: Record<string, unknown>;
    after?: Record<string, unknown> | null;
    deleteProduct?: boolean;
  }): PushEventDto {
    const event = sobreBase({
      eventId: options.eventId,
      aggregateType: 'product',
      aggregateId: options.productId,
      eventType: 'producto_actualizado',
      payload: {
        base_event_id: options.baseEventId,
        before: options.before,
        ...(options.deleteProduct
          ? { delete_product: true, after: null }
          : { after: options.after }),
      },
    });
    return { ...event, base_version: options.baseVersion };
  }

  async function alta(options: {
    eventId: string;
    inventoryItemId: string;
    name: string;
    unitId: string;
    originVariantId?: string;
  }): Promise<PushEventResultDto> {
    return database.transaction((manager) =>
      inventory.apply(
        manager,
        sobreBase({
          eventId: options.eventId,
          aggregateType: 'inventory_item',
          aggregateId: options.inventoryItemId,
          eventType: 'recurso_inventario_creado',
          payload: {
            inventory_item: {
              inventory_item_id: options.inventoryItemId,
              name: options.name,
              default_unit_id: options.unitId,
              ...(options.originVariantId
                ? { origin_variant_id: options.originVariantId }
                : {}),
            },
            initial_movement: {
              movement_id: `f1000000-0000-4000-8000-${options.inventoryItemId.slice(-12)}`,
              movement_type: 'initial_balance',
              quantity_delta_atomic: 250,
              reason: null,
              reversal_of_movement_id: null,
              total_cost_minor: null,
            },
          },
        }),
      ),
    );
  }

  function aplicarProductos(event: PushEventDto): Promise<PushEventResultDto> {
    return database.transaction((manager) => productos.apply(manager, event));
  }

  /** Estado que el servidor guardó para un evento, listo como `before`. */
  async function estadoPersistido(
    eventId: string,
  ): Promise<Record<string, unknown>> {
    const event = await database.manager.findOneByOrFail(EventEntity, {
      eventId,
    });
    const payload = event.payload as Record<string, unknown>;
    return ((payload.after as Record<string, unknown>) ?? payload) as Record<
      string,
      unknown
    >;
  }

  async function secuenciaDe(eventId: string): Promise<string> {
    const event = await database.manager.findOneByOrFail(EventEntity, {
      eventId,
    });
    return event.serverSequence;
  }

  async function memorias() {
    const rows = await database.manager.find(VariantInventoryMemoryEntity, {
      order: { variantId: 'ASC' },
    });
    return rows.map((row) => ({
      variantId: row.variantId,
      inventoryItemId: row.inventoryItemId,
      sourceEventId: row.sourceEventId,
      sourceServerSequence: row.sourceServerSequence,
    }));
  }
});

const DISPOSITIVO_LOCAL = 'dispositivo-inventario';
const CREADO_EN_LOCAL = '2026-10-01T12:00:00.000Z';
const PRODUCTO_PIEZAS = VARIANT_TRACKING_LOCAL.productoPiezas;
const PRODUCTO_AJENO = VARIANT_TRACKING_LOCAL.productoAjeno;
const VARIANTE_PIEZAS = VARIANT_TRACKING_LOCAL.variantePiezas;
const VARIANTE_AJENA = VARIANT_TRACKING_LOCAL.varianteAjena;
const VARIANTE_PROCEDENCIA = VARIANT_TRACKING_LOCAL.varianteProcedencia;
const RECURSO_PIEZAS = VARIANT_TRACKING_LOCAL.recursoPiezas;
const RECURSO_LIBRE = VARIANT_TRACKING_LOCAL.recursoLibre;
const RECURSO_EN_MASA = VARIANT_TRACKING_LOCAL.recursoEnMasa;
const RECURSO_INACTIVO = VARIANT_TRACKING_LOCAL.recursoInactivo;
const EV_ALTA_PIEZAS = VARIANT_TRACKING_LOCAL.evAltaPiezas;
const EV_ALTA_LIBRE = VARIANT_TRACKING_LOCAL.evAltaLibre;
const EV_ALTA_EN_MASA = VARIANT_TRACKING_LOCAL.evAltaEnMasa;
const EV_ALTA_INACTIVO = VARIANT_TRACKING_LOCAL.evAltaInactivo;
const EV_PRODUCTO_PIEZAS = VARIANT_TRACKING_LOCAL.evProductoCreado;
const EV_PRODUCTO_AJENO = VARIANT_TRACKING_LOCAL.evProductoAjeno;
const EV_RENOMBRE = VARIANT_TRACKING_LOCAL.evRenombre;
const EV_DESVINCULA = VARIANT_TRACKING_LOCAL.evDesvincula;
const EV_RECETA = VARIANT_TRACKING_LOCAL.evReceta;
const EV_VUELVE_DIRECTO = VARIANT_TRACKING_LOCAL.evVuelveDirecto;
const EV_RECUPERA = VARIANT_TRACKING_LOCAL.evRecupera;
const EV_REVINCULA_OTRO = VARIANT_TRACKING_LOCAL.evRevinculaOtro;
const EV_ECO_VIEJO = VARIANT_TRACKING_LOCAL.evEcoViejo;
const UNIDAD_PIEZA = VARIANT_TRACKING.unidadPieza;
const UNIDAD_GRAMO = VARIANT_TRACKING.unidadGramo;

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
