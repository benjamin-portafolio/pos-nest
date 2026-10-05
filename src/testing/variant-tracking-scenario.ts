import { DataSource } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { ProductEntity } from '../entities/product.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { UnitEntity } from '../entities/unit.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { SaleMode } from '../enums/sale-mode.enum';
import type { PushEventDto } from '../sync/dto/push-events.dto';
import type { InventoryEventHandler } from '../sync/inventory-event.handler';
import { readVariantTrackingFixture } from './variant-tracking-fixtures';

/**
 * Escenario compartido del contrato rev. 1 de seguimiento de existencias.
 *
 * Solo identities, seeds y lecturas de fixtures: ninguna regla de negocio. Las
 * expectativas viven en los specs que consumen este módulo
 * (`variant-inventory-memory`, `variant-tracking-late-sale`).
 *
 * Las identidades son las de `Fixtures/index.md` y ninguna prueba debe inventar
 * otras para el escenario documentado.
 */
export const VARIANT_TRACKING = {
  productoMolido: 'a1000000-0000-4000-8000-000000000001',
  variante250g: 'a2000000-0000-4000-8000-000000000001',
  variante1kg: 'a2000000-0000-4000-8000-000000000002',
  recursoMolido: 'a3000000-0000-4000-8000-000000000001',
  recursoVela: 'a3000000-0000-4000-8000-000000000002',
  recursoLegado: 'a3000000-0000-4000-8000-000000000003',
  recursoGrano: 'a4000000-0000-4000-8000-000000000001',
  unidadPieza: 'a5000000-0000-4000-8000-000000000001',
  unidadGramo: 'a5000000-0000-4000-8000-000000000002',
  unidadKilogramo: 'a5000000-0000-4000-8000-000000000003',
  evAltaMolido: 'b1000000-0000-4000-8000-000000000001',
  evAltaGrano: 'b1000000-0000-4000-8000-000000000004',
  evProductoCreado: 'b3000000-0000-4000-8000-000000000001',
  evProductoDesvincula: 'b3000000-0000-4000-8000-000000000003',
  evProductoReceta: 'b3000000-0000-4000-8000-000000000004',
  evProductoRecupera: 'b3000000-0000-4000-8000-000000000005',
  evDescarte: 'b3000000-0000-4000-8000-000000000006',
  evVentaTardia: 'b4000000-0000-4000-8000-000000000001',
} as const;

/**
 * Identidades locales de los casos que el escenario compartido no cubre (por
 * ejemplo la recuperación de un vínculo directo, imposible de aplicar por push
 * mientras la venta sea por unidad y el recurso se mida en gramos). No
 * suplantan las identidades del contrato: solo dan nombres estables a recursos
 * que ningún fixture describe.
 */
export const VARIANT_TRACKING_LOCAL = {
  productoPiezas: 'd1000000-0000-4000-8000-000000000001',
  variantePiezas: 'd2000000-0000-4000-8000-000000000001',
  productoAjeno: 'd1000000-0000-4000-8000-000000000002',
  varianteAjena: 'd2000000-0000-4000-8000-000000000002',
  productoProcedencia: 'd1000000-0000-4000-8000-000000000003',
  varianteProcedencia: 'd2000000-0000-4000-8000-000000000003',
  recursoPiezas: 'd3000000-0000-4000-8000-000000000001',
  recursoLibre: 'd3000000-0000-4000-8000-000000000002',
  recursoEnMasa: 'd3000000-0000-4000-8000-000000000003',
  recursoInactivo: 'd3000000-0000-4000-8000-000000000004',
  evAltaPiezas: 'e1000000-0000-4000-8000-000000000001',
  evAltaLibre: 'e1000000-0000-4000-8000-000000000002',
  evAltaEnMasa: 'e1000000-0000-4000-8000-000000000003',
  evAltaInactivo: 'e1000000-0000-4000-8000-000000000004',
  evProductoCreado: 'e2000000-0000-4000-8000-000000000001',
  evRenombre: 'e2000000-0000-4000-8000-000000000002',
  evDesvincula: 'e2000000-0000-4000-8000-000000000003',
  evRecupera: 'e2000000-0000-4000-8000-000000000004',
  evRevinculaOtro: 'e2000000-0000-4000-8000-000000000005',
  evReceta: 'e2000000-0000-4000-8000-000000000008',
  evProductoAjeno: 'e2000000-0000-4000-8000-000000000006',
  evProductoProcedencia: 'e2000000-0000-4000-8000-000000000007',
  evDescarteEnviado: 'e3000000-0000-4000-8000-000000000001',
  evEcoViejo: 'e3000000-0000-4000-8000-000000000002',
  evVuelveDirecto: 'e3000000-0000-4000-8000-000000000003',
  evVentaRepetida: 'e4000000-0000-4000-8000-000000000001',
} as const;

/** Sobre de push completo tal como lo emite `standalone`. */
export function variantTrackingEvent(relativePath: string): PushEventDto {
  return readVariantTrackingFixture(relativePath) as unknown as PushEventDto;
}

/**
 * Unidades del escenario con las dimensiones de `generar_fixtures.py`: piezas,
 * gramos y kilogramos. El escenario compartido mide el recurso de vínculo
 * directo en gramos y vende por unidad, combinación que el servidor rechaza
 * (§`validateInventoryTrackingUnit`); por eso los casos que necesitan un
 * vínculo directo aplicable usan recursos en piezas.
 */
export async function seedVariantTrackingUnits(
  database: DataSource,
): Promise<void> {
  await database.manager.save(
    [
      {
        unitId: VARIANT_TRACKING.unidadPieza,
        code: 'piece',
        name: 'Pieza',
        symbol: 'pza',
        dimension: 'count',
        atomicFactor: '1',
        maxFractionDigits: 0,
        active: true,
      },
      {
        unitId: VARIANT_TRACKING.unidadGramo,
        code: 'g',
        name: 'Gramo',
        symbol: 'g',
        dimension: 'mass',
        atomicFactor: '1',
        maxFractionDigits: 0,
        active: true,
      },
      {
        unitId: VARIANT_TRACKING.unidadKilogramo,
        code: 'kg',
        name: 'Kilogramo',
        symbol: 'kg',
        dimension: 'mass',
        atomicFactor: '1000',
        maxFractionDigits: 3,
        active: true,
      },
    ].map((unit) => database.manager.create(UnitEntity, unit)),
  );
}

/** Aplica un sobre de recurso del escenario con el handler de inventario real. */
async function applyVariantTrackingAlta(
  database: DataSource,
  inventory: InventoryEventHandler,
  relativePath: string,
): Promise<void> {
  const event = variantTrackingEvent(relativePath);
  const result = await database.transaction((manager) =>
    inventory.apply(manager, event),
  );
  if (result.status !== 'accepted') {
    throw new Error(
      `El alta ${event.event_id} no fue aceptada: ${result.reason ?? 'sin motivo'}.`,
    );
  }
}

/**
 * Alta del recurso de receta que declara `producto-directo-a-receta.json`.
 *
 * `Fixtures/index.md` reserva la identidad `b1000000-…-000000000004` para el
 * «evento de alta de receta», pero el conjunto de fixtures no publica su sobre.
 * Se reconstruye con las dimensiones de `generar_fixtures.py`: kilogramo y sin
 * procedencia, porque un recurso de receta es independiente de la variante que
 * lo consume. `local_sequence` 5 evita chocar con los eventos del escenario
 * (alta 1, creación 2, desvinculación 3, receta 4).
 */
export async function applySharedRecipeResource(
  database: DataSource,
  inventory: InventoryEventHandler,
): Promise<void> {
  const result = await database.transaction((manager) =>
    inventory.apply(manager, {
      event_id: VARIANT_TRACKING.evAltaGrano,
      aggregate_type: 'inventory_item',
      aggregate_id: VARIANT_TRACKING.recursoGrano,
      event_type: 'recurso_inventario_creado',
      device_id: 'dispositivo-1',
      user_id: 'usuario-1',
      local_sequence: 5,
      base_server_sequence: null,
      base_version: 1,
      created_at_local: '2026-10-01T12:00:00.000Z',
      payload: {
        inventory_item: {
          inventory_item_id: VARIANT_TRACKING.recursoGrano,
          name: 'Café en grano 1 kg',
          default_unit_id: VARIANT_TRACKING.unidadKilogramo,
        },
        initial_movement: {
          movement_id: 'b2000000-0000-4000-8000-000000000003',
          movement_type: 'initial_balance',
          quantity_delta_atomic: 1000,
          reason: null,
          reversal_of_movement_id: null,
          total_cost_minor: null,
        },
      },
    }),
  );
  if (result.status !== 'accepted') {
    throw new Error(
      `El alta de receta no fue aceptada: ${result.reason ?? 'sin motivo'}.`,
    );
  }
}

/**
 * Estado de configuración del escenario compartido: es el `before` del fixture
 * de desvinculación, es decir la configuración directa que el servidor ya
 * tenía aceptada.
 */
function sharedDirectState(): Record<string, unknown> {
  const event = variantTrackingEvent(
    'producto/producto-directo-a-ninguno.json',
  );
  return (event.payload as Record<string, unknown>).before as Record<
    string,
    unknown
  >;
}

/**
 * Deja el estado que el escenario compartido da por aceptado **antes** de la
 * desvinculación: recurso real con procedencia y saldo 250/250, más el producto
 * con sus dos variantes y el evento de creación ya sincronizado.
 *
 * El producto se siembra por escrito y no por push a propósito: el escenario
 * combina venta por unidad con un recurso en gramos, y
 * `validateInventoryTrackingUnit` solo admite piezas para la venta por unidad.
 * Es una restricción vigente del servidor, anterior a este plan; sembrarla
 * documenta el estado que la otra terminal había aceptado, sin relajar la
 * validación.
 */
export async function seedSharedDirectLink(
  database: DataSource,
  inventory: InventoryEventHandler,
): Promise<void> {
  await applyVariantTrackingAlta(
    database,
    inventory,
    'alta/alta-autogenerada-inicial-positiva.json',
  );

  const state = sharedDirectState();
  await database.manager.save(
    database.manager.create(ProductEntity, {
      id: VARIANT_TRACKING.productoMolido,
      name: 'Café molido',
      categoryId: null,
      saleMode: SaleMode.UNIT,
      saleUnitId: null,
      priceReferenceQuantityAtomic: null,
      active: true,
      version: 1,
      createdEventId: VARIANT_TRACKING.evProductoCreado,
      lastEventId: VARIANT_TRACKING.evProductoCreado,
      lastServerSequence: null,
    }),
  );
  await database.manager.save(
    (state.variants as Array<Record<string, unknown>>).map((variant) =>
      database.manager.create(ProductVariantEntity, {
        id: variant.variant_id as string,
        productId: VARIANT_TRACKING.productoMolido,
        name: variant.name as string,
        nameKey: (variant.name as string).toLowerCase(),
        barcode: null,
        salePriceMinor: String(variant.sale_price_minor),
        standardCostMinor: String(variant.standard_cost_minor),
        inventoryItemId: (variant.inventory_item_id as string | null) ?? null,
        sortOrder: variant.sort_order as number,
        active: true,
        version: 1,
        createdEventId: VARIANT_TRACKING.evProductoCreado,
        lastEventId: VARIANT_TRACKING.evProductoCreado,
        lastServerSequence: null,
      }),
    ),
  );
  await database.manager.save(
    database.manager.create(EventEntity, {
      eventId: VARIANT_TRACKING.evProductoCreado,
      aggregateType: 'product',
      aggregateId: VARIANT_TRACKING.productoMolido,
      eventType: 'producto_creado',
      deviceId: 'dispositivo-1',
      userId: 'usuario-1',
      localSequence: 2,
      baseServerSequence: null,
      baseVersion: 1,
      createdAtLocal: new Date('2026-10-01T12:00:00.000Z'),
      payload: state,
      syncStatus: EventSyncStatus.SYNCED,
      rejectionReason: null,
    }),
  );
}
