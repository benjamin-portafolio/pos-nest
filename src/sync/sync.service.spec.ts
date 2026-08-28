import type { DataSource, EntityManager } from 'typeorm';
import type { EventEntity } from '../entities/event.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import type { EventsGateway } from '../events/events.gateway';
import type { CategoriaEventHandler } from './categoria-event.handler';
import type { ProductoEventHandler } from './producto-event.handler';
import type { InventoryEventHandler } from './inventory-event.handler';
import type { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';

type EspacioPayloadParser = {
  parseEspacioCreadoPayload(payload: Record<string, unknown>): unknown;
};

describe('SyncService', () => {
  const conflictService = {} as SyncConflictService;
  const service = new SyncService(
    {} as DataSource,
    {} as EventsGateway,
    conflictService,
  );
  const parser = service as unknown as EspacioPayloadParser;
  const parseEspacioCreadoPayload = (
    payload: Record<string, unknown>,
  ): unknown => parser.parseEspacioCreadoPayload(payload);

  describe('health', () => {
    it('devuelve el ultimo server_sequence sincronizado', async () => {
      const queryBuilder = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ latest_server_sequence: '12' }),
      };
      const dataSource = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        }),
      } as unknown as DataSource;
      const healthService = new SyncService(
        dataSource,
        {} as EventsGateway,
        conflictService,
      );

      const response = await healthService.health();

      expect(response).toEqual({
        status: 'ok',
        latest_server_sequence: 12,
        server_time: response.server_time,
      });
      expect(typeof response.server_time).toBe('string');

      expect(queryBuilder.select).toHaveBeenCalledWith(
        'MAX(event.server_sequence)',
        'latest_server_sequence',
      );
      expect(queryBuilder.where).toHaveBeenCalledWith(
        'event.sync_status = :syncStatus',
        { syncStatus: EventSyncStatus.SYNCED },
      );
    });
  });

  describe('parseEspacioCreadoPayload', () => {
    it('acepta los valores de evento que envia Flutter', () => {
      expect(
        parseEspacioCreadoPayload({
          nombre: ' Salon ',
          identificacion: null,
          visibilidad: 'sin_restriccion',
        }),
      ).toEqual({
        nombre: 'Salon',
        identificacion: null,
        visibilidad: 0,
      });

      expect(
        parseEspacioCreadoPayload({
          nombre: 'Barra',
          identificacion: ' barra ',
          visibilidad: 'solo_restringido',
        }),
      ).toEqual({
        nombre: 'Barra',
        identificacion: 'barra',
        visibilidad: 1,
      });
    });

    it('mantiene compatibilidad con indices legados', () => {
      expect(
        parseEspacioCreadoPayload({
          nombre: 'Salon',
          identificacion: null,
          visibilidad: 1,
        }),
      ).toEqual({
        nombre: 'Salon',
        identificacion: null,
        visibilidad: 1,
      });
    });

    it('rechaza valores de visibilidad desconocidos', () => {
      expect(
        parseEspacioCreadoPayload({
          nombre: 'Salon',
          identificacion: null,
          visibilidad: 'publico',
        }),
      ).toEqual({
        error: 'payload.visibilidad desconocida: publico.',
      });
    });
  });

  describe('pullEvents', () => {
    it('devuelve eventos sincronizados posteriores al cursor', async () => {
      const categoryDeletion = eventRecord({
        eventId: 'event_4',
        serverSequence: '4',
      });
      categoryDeletion.aggregateType = 'category';
      categoryDeletion.eventType = 'categoria_eliminada';
      categoryDeletion.payload = {
        base_event_id: 'category_base',
        deleted_category: {
          name: 'Bebidas',
          color_key: 'cyan',
          sort_order: 0,
          active: true,
          created_event_id: 'category_created',
        },
        product_resolution: { type: 'uncategorize' },
        linked_products: [
          {
            product_id: 'product_1',
            base_event_id: 'product_base',
            base_version: 2,
            base_server_sequence: 3,
            category_id: { from: categoryDeletion.aggregateId, to: null },
          },
        ],
        shifted_categories: [],
      };
      const queryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([
            categoryDeletion,
            eventRecord({ eventId: 'event_5', serverSequence: '5' }),
          ]),
      };
      const dataSource = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        }),
      } as unknown as DataSource;
      const pullService = new SyncService(
        dataSource,
        {} as EventsGateway,
        conflictService,
      );

      await expect(
        pullService.pullEvents({ since: '3', limit: '100' }),
      ).resolves.toEqual({
        events: [
          expect.objectContaining({
            event_id: 'event_4',
            server_sequence: 4,
            sync_status: 'synced',
            payload: categoryDeletion.payload,
          }),
          expect.objectContaining({
            event_id: 'event_5',
            server_sequence: 5,
            sync_status: 'synced',
          }),
        ],
        next_cursor: 5,
        has_more: false,
      });

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'event.server_sequence > :since',
        { since: 3 },
      );
      expect(queryBuilder.take).toHaveBeenCalledWith(101);
    });

    it('marca has_more cuando el servidor devuelve mas de un lote', async () => {
      const queryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([
            eventRecord({ eventId: 'event_4', serverSequence: '4' }),
            eventRecord({ eventId: 'event_5', serverSequence: '5' }),
          ]),
      };
      const dataSource = {
        getRepository: jest.fn().mockReturnValue({
          createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
        }),
      } as unknown as DataSource;
      const pullService = new SyncService(
        dataSource,
        {} as EventsGateway,
        conflictService,
      );

      await expect(
        pullService.pullEvents({ since: 3, limit: 1 }),
      ).resolves.toEqual({
        events: [
          expect.objectContaining({
            event_id: 'event_4',
            server_sequence: 4,
          }),
        ],
        next_cursor: 4,
        has_more: true,
      });
    });
  });

  describe('pushEvents', () => {
    it('despacha categoria_creada y publica el aviso de eventos', async () => {
      const accepted = eventRecord({
        eventId: 'event_category',
        serverSequence: '12',
      });
      accepted.aggregateType = 'category';
      accepted.eventType = 'categoria_creada';
      const repository = {
        findOneBy: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(accepted),
      };
      const manager = {} as EntityManager;
      const dataSource = {
        getRepository: jest.fn().mockReturnValue(repository),
        transaction: jest.fn(
          async (callback: (manager: EntityManager) => Promise<unknown>) =>
            callback(manager),
        ),
      } as unknown as DataSource;
      const notifyEventsAvailable = jest.fn();
      const gateway = {
        notifyEventsAvailable,
      } as unknown as EventsGateway;
      const applyCategoria = jest.fn().mockResolvedValue({
        event_id: 'event_category',
        status: 'accepted',
        server_sequence: 12,
        created_at_server: '2026-06-09T20:31:00.000Z',
      });
      const categoriaHandler = {
        supports: jest
          .fn()
          .mockImplementation(
            (eventType: string) =>
              eventType === 'categoria_creada' ||
              eventType === 'categoria_actualizada' ||
              eventType === 'categoria_movida',
          ),
        apply: applyCategoria,
        saveUniqueViolationConflict: jest.fn().mockResolvedValue({
          event_id: 'event_category',
          status: 'conflict',
          server_sequence: 12,
          created_at_server: '2026-06-09T20:31:00.000Z',
        }),
      } as unknown as CategoriaEventHandler;
      const pushService = new SyncService(
        dataSource,
        gateway,
        conflictService,
        categoriaHandler,
      );

      const response = await pushService.pushEvents({
        device_id: 'device_tablet_01',
        events: [
          {
            event_id: 'event_category',
            aggregate_type: 'category',
            aggregate_id: '00000000-0000-4000-8000-000000000002',
            event_type: 'categoria_creada',
            device_id: 'device_tablet_01',
            user_id: 'user_01',
            local_sequence: 2,
            base_version: 1,
            created_at_local: '2026-06-09T20:30:00.000Z',
            payload: {
              name: 'Bebidas',
              color_key: 'cyan',
              sort_order: 0,
            },
          },
        ],
      });

      expect(response.results[0]).toEqual(
        expect.objectContaining({ status: 'accepted' }),
      );
      expect(applyCategoria).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ event_type: 'categoria_creada' }),
      );
      expect(notifyEventsAvailable).toHaveBeenCalledWith({
        latestServerSequence: 12,
        eventTypes: ['categoria_creada'],
        sourceDeviceId: 'device_tablet_01',
      });
    });

    it('despacha producto_creado al handler de producto', async () => {
      const accepted = eventRecord({
        eventId: 'event_product',
        serverSequence: '13',
      });
      accepted.aggregateType = 'product';
      accepted.eventType = 'producto_creado';
      const repository = {
        findOneBy: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(accepted),
      };
      const manager = {} as EntityManager;
      const dataSource = {
        getRepository: jest.fn().mockReturnValue(repository),
        transaction: jest.fn(
          async (callback: (manager: EntityManager) => Promise<unknown>) =>
            callback(manager),
        ),
      } as unknown as DataSource;
      const applyProduct = jest.fn().mockResolvedValue({
        event_id: 'event_product',
        status: 'accepted',
        server_sequence: 13,
        created_at_server: '2026-08-05T20:31:00.000Z',
      });
      const productHandler = {
        supports: jest.fn(
          (eventType: string) => eventType === 'producto_creado',
        ),
        apply: applyProduct,
        saveUniqueViolationConflict: jest.fn(),
      } as unknown as ProductoEventHandler;
      const pushService = new SyncService(
        dataSource,
        { notifyEventsAvailable: jest.fn() } as unknown as EventsGateway,
        conflictService,
        undefined,
        productHandler,
      );

      const response = await pushService.pushEvents({
        device_id: 'device_tablet_01',
        events: [
          {
            event_id: 'event_product',
            aggregate_type: 'product',
            aggregate_id: '00000000-0000-4000-8000-000000000002',
            event_type: 'producto_creado',
            device_id: 'device_tablet_01',
            user_id: 'user_01',
            local_sequence: 3,
            base_server_sequence: null,
            base_version: 1,
            created_at_local: '2026-08-05T20:30:00.000Z',
            payload: {},
          },
        ],
      });

      expect(response.results[0]).toEqual(
        expect.objectContaining({ status: 'accepted' }),
      );
      expect(applyProduct).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ event_type: 'producto_creado' }),
      );
    });

    it('despacha recurso_inventario_creado y notifica para pull', async () => {
      const accepted = eventRecord({
        eventId: 'event_inventory',
        serverSequence: '15',
      });
      accepted.aggregateType = 'inventory_item';
      accepted.eventType = 'recurso_inventario_creado';
      const repository = {
        findOneBy: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(accepted),
      };
      const manager = {} as EntityManager;
      const dataSource = {
        getRepository: jest.fn().mockReturnValue(repository),
        transaction: jest.fn(
          async (callback: (manager: EntityManager) => Promise<unknown>) =>
            callback(manager),
        ),
      } as unknown as DataSource;
      const applyInventory = jest.fn().mockResolvedValue({
        event_id: 'event_inventory',
        status: 'accepted',
        server_sequence: 15,
        created_at_server: '2026-08-19T20:31:00.000Z',
      });
      const inventoryHandler = {
        supports: jest.fn(
          (eventType: string) => eventType === 'recurso_inventario_creado',
        ),
        apply: applyInventory,
        saveUniqueViolationConflict: jest.fn(),
      } as unknown as InventoryEventHandler;
      const notify = jest.fn();
      const pushService = new SyncService(
        dataSource,
        { notifyEventsAvailable: notify } as unknown as EventsGateway,
        conflictService,
        undefined,
        undefined,
        inventoryHandler,
      );

      const response = await pushService.pushEvents({
        device_id: 'device_tablet_01',
        events: [
          {
            event_id: 'event_inventory',
            aggregate_type: 'inventory_item',
            aggregate_id: '20000000-0000-4000-8000-000000000001',
            event_type: 'recurso_inventario_creado',
            device_id: 'device_tablet_01',
            user_id: 'user_01',
            local_sequence: 4,
            base_server_sequence: null,
            base_version: 1,
            created_at_local: '2026-08-19T20:30:00.000Z',
            payload: {},
          },
        ],
      });

      expect(response.results[0]?.status).toBe('accepted');
      expect(applyInventory).toHaveBeenCalledWith(manager, expect.any(Object));
      expect(notify).toHaveBeenCalledWith({
        latestServerSequence: 15,
        eventTypes: ['recurso_inventario_creado'],
        sourceDeviceId: 'device_tablet_01',
      });
    });

    it('despacha categoria_eliminada al handler de categoría', async () => {
      const accepted = eventRecord({
        eventId: 'event_category_deleted',
        serverSequence: '14',
      });
      accepted.aggregateType = 'category';
      accepted.eventType = 'categoria_eliminada';
      const repository = {
        findOneBy: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(accepted),
      };
      const manager = {} as EntityManager;
      const dataSource = {
        getRepository: jest.fn().mockReturnValue(repository),
        transaction: jest.fn(
          async (callback: (manager: EntityManager) => Promise<unknown>) =>
            callback(manager),
        ),
      } as unknown as DataSource;
      const applyCategoria = jest.fn().mockResolvedValue({
        event_id: 'event_category_deleted',
        status: 'accepted',
        server_sequence: 14,
        created_at_server: '2026-08-12T20:31:00.000Z',
      });
      const categoryHandler = {
        supports: jest.fn(
          (eventType: string) => eventType === 'categoria_eliminada',
        ),
        apply: applyCategoria,
        saveUniqueViolationConflict: jest.fn(),
      } as unknown as CategoriaEventHandler;
      const pushService = new SyncService(
        dataSource,
        { notifyEventsAvailable: jest.fn() } as unknown as EventsGateway,
        conflictService,
        categoryHandler,
      );

      const response = await pushService.pushEvents({
        device_id: 'device_tablet_01',
        events: [
          {
            event_id: 'event_category_deleted',
            aggregate_type: 'category',
            aggregate_id: '00000000-0000-4000-8000-000000000002',
            event_type: 'categoria_eliminada',
            device_id: 'device_tablet_01',
            user_id: 'user_01',
            local_sequence: 4,
            base_server_sequence: 10,
            base_version: 1,
            created_at_local: '2026-08-12T20:30:00.000Z',
            payload: {},
          },
        ],
      });

      expect(response.results[0]).toEqual(
        expect.objectContaining({ status: 'accepted' }),
      );
      expect(applyCategoria).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ event_type: 'categoria_eliminada' }),
      );
    });

    it('informa original_sync_status cuando el duplicado era conflictivo', async () => {
      const duplicate = eventRecord({
        eventId: 'event_conflict',
        serverSequence: '7',
      });
      duplicate.syncStatus = EventSyncStatus.CONFLICT;
      duplicate.rejectionReason =
        'Ya existe un espacio con identificacion terraza.';
      const dataSource = {
        getRepository: jest.fn().mockReturnValue({
          findOneBy: jest.fn().mockResolvedValue(duplicate),
        }),
      } as unknown as DataSource;
      const notifyEventsAvailable = jest.fn();
      const gateway = {
        notifyEventsAvailable,
      } as unknown as EventsGateway;
      const pushService = new SyncService(dataSource, gateway, conflictService);

      const response = await pushService.pushEvents({
        device_id: 'device_tablet_01',
        events: [
          {
            event_id: 'event_conflict',
            aggregate_type: 'espacio',
            aggregate_id: '00000000-0000-4000-8000-000000000001',
            event_type: 'espacio_creado',
            device_id: 'device_tablet_01',
            user_id: 'user_01',
            local_sequence: 1,
            created_at_local: '2026-06-09T20:30:00.000Z',
            payload: {
              nombre: 'Terraza',
              identificacion: 'terraza',
              visibilidad: 'sin_restriccion',
            },
          },
        ],
      });

      expect(response).toEqual({
        results: [
          {
            event_id: 'event_conflict',
            status: 'duplicate',
            server_sequence: 7,
            created_at_server: '2026-06-09T20:31:00.000Z',
            reason: 'Ya existe un espacio con identificacion terraza.',
            original_sync_status: EventSyncStatus.CONFLICT,
          },
        ],
        server_time: response.server_time,
      });
      expect(typeof response.server_time).toBe('string');
      expect(notifyEventsAvailable).not.toHaveBeenCalled();
    });
  });

  describe('preflightEvents', () => {
    it('omite consulta de eventos cuando no hay pendientes', async () => {
      const latestQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ latest_server_sequence: '12' }),
      };
      const createQueryBuilder = jest.fn().mockReturnValue(latestQueryBuilder);
      const dataSource = {
        getRepository: jest.fn().mockReturnValue({ createQueryBuilder }),
      } as unknown as DataSource;
      const preflightService = new SyncService(
        dataSource,
        {} as EventsGateway,
        conflictService,
      );

      await expect(
        preflightService.preflightEvents({
          device_id: 'device_tablet_01',
          last_full_pull_server_sequence: 3,
          max_events: 100,
          pending_refs: [],
        }),
      ).resolves.toEqual({
        events: [],
        preflight_sequence: 12,
        has_more: false,
        requires_full_pull_before_push: false,
        reason: null,
      });

      expect(createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('devuelve eventos impactantes por event_refs y exige pull si rebasa limite', async () => {
      const latestQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest
          .fn()
          .mockResolvedValue({ latest_server_sequence: '12' }),
      };
      const preflightQueryBuilder = {
        distinct: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([
            eventRecord({ eventId: 'event_4', serverSequence: '4' }),
            eventRecord({ eventId: 'event_5', serverSequence: '5' }),
          ]),
      };
      const createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(latestQueryBuilder)
        .mockReturnValueOnce(preflightQueryBuilder);
      const dataSource = {
        getRepository: jest.fn().mockReturnValue({ createQueryBuilder }),
      } as unknown as DataSource;
      const preflightService = new SyncService(
        dataSource,
        {} as EventsGateway,
        conflictService,
      );

      await expect(
        preflightService.preflightEvents({
          device_id: 'device_tablet_01',
          last_full_pull_server_sequence: 3,
          max_events: 1,
          pending_refs: [
            {
              event_id: 'local_event',
              event_type: 'categoria_eliminada',
              aggregate_type: 'category',
              aggregate_id: '00000000-0000-4000-8000-000000000009',
              refs: [
                {
                  type: 'category',
                  id: '00000000-0000-4000-8000-000000000009',
                  relationship: 'affects',
                },
                {
                  type: 'product',
                  id: '00000000-0000-4000-8000-000000000010',
                  relationship: 'affects',
                },
              ],
            },
          ],
        }),
      ).resolves.toEqual({
        events: [
          expect.objectContaining({
            event_id: 'event_4',
            server_sequence: 4,
            sync_status: 'synced',
          }),
        ],
        preflight_sequence: 12,
        has_more: true,
        requires_full_pull_before_push: true,
        reason: 'too_many_impacting_events',
      });

      expect(preflightQueryBuilder.innerJoin).toHaveBeenCalled();
      expect(preflightQueryBuilder.andWhere).toHaveBeenCalledWith(
        'event.server_sequence > :since',
        { since: 3 },
      );
      expect(preflightQueryBuilder.take).toHaveBeenCalledWith(2);
    });
  });
});

function eventRecord({
  eventId,
  serverSequence,
}: {
  eventId: string;
  serverSequence: string;
}): EventEntity {
  return {
    eventId,
    aggregateType: 'espacio',
    aggregateId: '00000000-0000-4000-8000-000000000001',
    eventType: 'espacio_creado',
    deviceId: 'device_tablet_01',
    userId: 'user_01',
    localSequence: 1,
    serverSequence,
    baseServerSequence: null,
    baseVersion: 1,
    createdAtLocal: new Date('2026-06-09T20:30:00.000Z'),
    createdAtServer: new Date('2026-06-09T20:31:00.000Z'),
    payload: {
      nombre: 'Salon',
      identificacion: null,
      visibilidad: 'sin_restriccion',
    },
    syncStatus: EventSyncStatus.SYNCED,
    rejectionReason: null,
    updatedAtServer: new Date('2026-06-09T20:31:00.000Z'),
  };
}
