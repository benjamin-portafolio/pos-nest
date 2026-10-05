import { DataSource } from 'typeorm';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { SaleItemEntity } from '../entities/sale-item.entity';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { SaleEntity } from '../entities/sale.entity';
import { VariantInventoryMemoryEntity } from '../entities/variant-inventory-memory.entity';
import type { EventsGateway } from '../events/events.gateway';
import {
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
import { VentaEventHandler } from './venta-event.handler';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

/**
 * Venta posterior a la desvinculación (contrato rev. 1 §7 y
 * `Fixtures/venta_tardia`).
 *
 * La venta se confirma contra la **configuración histórica** que capturó la
 * línea, no contra el vínculo vigente: la variante ya no tiene recurso directo,
 * pero la venta igual consume el recurso de su `configuration_event_id`. Por eso
 * el spec empuja por `SyncService` y no llama al handler aislado: la aceptación
 * depende de que las dependencias históricas existan ya sincronizadas.
 */
runPostgresIntegration(
  'Venta posterior a la desvinculación (PostgreSQL real)',
  () => {
    jest.setTimeout(30_000);

    const schema = `variant_late_sale_it_${process.pid}_${Date.now()}`;
    let administration: DataSource;
    let database: DataSource;
    let inventory: InventoryEventHandler;
    let servicio: SyncService;
    let notificar: jest.Mock;

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

      const conflicts = {
        recordConflict: jest.fn().mockResolvedValue({
          conflictId: '90000000-0000-4000-8000-0000000000fe',
        }),
      } as unknown as SyncConflictService;
      inventory = new InventoryEventHandler(conflicts);
      notificar = jest.fn();
      // Orden de constructor de `SyncService`: datos, gateway, conflictos,
      // categoría, producto, inventario, venta.
      servicio = new SyncService(
        database,
        { notifyEventsAvailable: notificar } as unknown as EventsGateway,
        conflicts,
        undefined,
        new ProductoEventHandler(conflicts),
        inventory,
        new VentaEventHandler(conflicts),
      );
    });

    afterAll(async () => {
      if (database?.isInitialized) await database.destroy();
      if (administration?.isInitialized) {
        await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
        await administration.destroy();
      }
    });

    beforeEach(async () => {
      notificar.mockClear();
      await database.query(`
      TRUNCATE TABLE
        "${schema}"."credit_allocations",
        "${schema}"."customer_payments",
        "${schema}"."credit_sales",
        "${schema}"."sale_payments",
        "${schema}"."sale_items",
        "${schema}"."sales",
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
      await seedSharedDirectLink(database, inventory);
    });

    it('acepta una sola vez la venta contra el recurso de su configuración capturada', async () => {
      const desvincula = await empujar(
        'producto/producto-directo-a-ninguno.json',
      );
      expect(desvincula.status).toBe('accepted');

      const venta = await empujarSobre(ventaTardia());

      expect(venta.status).toBe('accepted');
      // Saldo final del recurso: 250 del alta menos las 2 piezas vendidas.
      expect(
        await database.manager.findOneByOrFail(InventoryBalanceEntity, {
          inventoryItemId: VARIANT_TRACKING.recursoMolido,
        }),
      ).toEqual(
        expect.objectContaining({
          quantityOnHandAtomic: '248',
          quantityAvailableAtomic: '248',
        }),
      );
      // El recurso sobrevive: desvincular no lo purga en `server_sync`.
      const recurso = await database.manager.findOneByOrFail(
        InventoryItemEntity,
        { id: VARIANT_TRACKING.recursoMolido },
      );
      expect(recurso.active).toBe(true);
      expect(recurso.originVariantId).toBe(VARIANT_TRACKING.variante250g);
      // Venta, línea y pago se registran una vez, con el precio capturado.
      expect(await database.manager.count(SaleEntity)).toBe(1);
      expect(await database.manager.count(SaleItemEntity)).toBe(1);
      expect(await database.manager.count(SalePaymentEntity)).toBe(1);
      expect(
        (
          await database.manager.findOneByOrFail(SaleItemEntity, {
            id: 'b7000000-0000-4000-8000-000000000001',
          })
        ).totalMinor,
      ).toBe('9000');
      // El alta inicial más el consumo de la venta, ninguno más.
      const movimientos = await database.manager.find(InventoryMovementEntity, {
        where: { inventoryItemId: VARIANT_TRACKING.recursoMolido },
        order: { serverSequence: 'ASC' },
      });
      expect(movimientos.map((movimiento) => movimiento.movementType)).toEqual([
        'initial_balance',
        'sale_consumption',
      ]);
      expect(movimientos[1]?.quantityDeltaAtomic).toBe('-2');
    });

    it('no reactiva el vínculo ni altera la memoria con la venta tardía', async () => {
      await empujar('producto/producto-directo-a-ninguno.json');
      const memoriaAntes = await memoria();

      const venta = await empujarSobre(ventaTardia());

      expect(venta.status).toBe('accepted');
      // La venta consume el recurso capturado, pero no reconstruye el vínculo.
      expect(
        (
          await database.manager.findOneByOrFail(ProductVariantEntity, {
            id: VARIANT_TRACKING.variante250g,
          })
        ).inventoryItemId,
      ).toBeNull();
      expect(await memoria()).toEqual(memoriaAntes);
      expect(memoriaAntes[0]?.sourceEventId).toBe(
        VARIANT_TRACKING.evProductoDesvincula,
      );
      expect(memoriaAntes[0]?.inventoryItemId).toBe(
        VARIANT_TRACKING.recursoMolido,
      );
    });

    it('confirma la venta una sola vez por event_id y una sola vez por venta', async () => {
      await empujar('producto/producto-directo-a-ninguno.json');
      expect((await empujarSobre(ventaTardia())).status).toBe('accepted');
      const notificados = notificar.mock.calls.length;

      // Reenviar el mismo evento es un duplicado, no un segundo consumo.
      const repetido = await empujarSobre(ventaTardia());
      expect(repetido.status).toBe('duplicate');

      // Mismo `sale_id` con otro `event_id` es un conflicto de integridad.
      const mismaVenta = await empujarSobre({
        ...ventaTardia(),
        event_id: VARIANT_TRACKING_LOCAL.evVentaRepetida,
        local_sequence: 7,
      });
      expect(mismaVenta.status).toBe('conflict');
      expect(mismaVenta.reason).toContain('ya fue confirmada');
      expect(await database.manager.count(SaleEntity)).toBe(1);
      expect(await database.manager.count(SaleItemEntity)).toBe(1);
      // Solo el consumo de la venta aceptada: ni el duplico ni el conflicto
      // movieron el saldo.
      expect(
        await database.manager.countBy(InventoryMovementEntity, {
          inventoryItemId: VARIANT_TRACKING.recursoMolido,
        }),
      ).toBe(2);
      expect(
        (
          await database.manager.findOneByOrFail(InventoryBalanceEntity, {
            inventoryItemId: VARIANT_TRACKING.recursoMolido,
          })
        ).quantityOnHandAtomic,
      ).toBe('248');
      // Solo lo aceptado notifica disponibilidad: duplico y conflicto no
      // añaden avisos.
      expect(notificados).toBe(2);
      expect(notificar).toHaveBeenCalledTimes(notificados);
    });

    /**
     * `venta-tardia-consumo-original.json` declara `base_version: null`, y toda
     * venta confirmada exige `base_version: 1` sin base oficial en
     * `VentaEventHandler`: regla vigente del servidor, anterior a este plan. Se
     * corrige el sobre de forma explícita para poder ejercitar el caso; el payload
     * de la venta no se toca. El `local_sequence` del fixture es 6 y no colisiona
     * con el 7 de la repetición.
     */
    function ventaTardia(): PushEventDto {
      return {
        ...variantTrackingEvent(
          'venta_tardia/venta-tardia-consumo-original.json',
        ),
        base_version: 1,
      };
    }

    async function empujar(relativePath: string): Promise<PushEventResultDto> {
      return empujarSobre(variantTrackingEvent(relativePath));
    }

    async function empujarSobre(
      event: PushEventDto,
    ): Promise<PushEventResultDto> {
      const respuesta = await servicio.pushEvents({
        device_id: event.device_id,
        events: [event],
      });
      return respuesta.results[0]!;
    }

    async function memoria() {
      const filas = await database.manager.find(VariantInventoryMemoryEntity, {
        order: { variantId: 'ASC' },
      });
      return filas.map((fila) => ({
        variantId: fila.variantId,
        inventoryItemId: fila.inventoryItemId,
        sourceEventId: fila.sourceEventId,
        sourceServerSequence: fila.sourceServerSequence,
      }));
    }
  },
);

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
