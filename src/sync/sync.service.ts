import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Brackets, DataSource, EntityManager, In } from 'typeorm';
import { EspacioEntity } from '../entities/espacio.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { SyncConflictParticipantEntity } from '../entities/sync-conflict-participant.entity';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { SyncConflictStatus } from '../enums/sync-conflict-status.enum';
import { EventsGateway } from '../events/events.gateway';
import type {
  ListConflictDto,
  ListConflictParticipantDto,
  ListConflictsQueryDto,
  ListConflictsResponseDto,
} from './dto/list-conflicts.dto';
import type {
  PullEventDto,
  PullEventsQueryDto,
  PullEventsResponseDto,
} from './dto/pull-events.dto';
import type {
  PreflightEventRefDto,
  PreflightEventsDto,
  PreflightEventsResponseDto,
} from './dto/preflight-events.dto';
import type {
  PushEventDto,
  PushEventResultDto,
  PushEventsDto,
  PushEventsResponseDto,
} from './dto/push-events.dto';
import type {
  ReportConflictEventDto,
  ReportConflictRefDto,
  ReportConflictResultDto,
  ReportConflictsDto,
  ReportConflictsResponseDto,
} from './dto/report-conflicts.dto';
import type { SyncHealthResponseDto } from './dto/sync-health.dto';
import { CategoriaEventHandler } from './categoria-event.handler';
import { ProductoEventHandler } from './producto-event.handler';
import { InventoryEventHandler } from './inventory-event.handler';
import { CategoriaEliminadaPayload } from './payloads/categoria-eliminada.payload';
import { SyncConflictService } from './sync-conflict.service';
import { RecursoInventarioCreadoPayload } from './payloads/recurso-inventario-creado.payload';

interface EspacioCreadoPayload {
  nombre: string;
  identificacion: string | null;
  visibilidad: number;
}

interface ConflictRef {
  type: string;
  id: string;
  relationship: string | null;
}

interface ConflictTarget {
  conflictType: string;
  refType: string;
  refId: string;
  defaultWinnerEventId: string | null;
}

interface EventResultOptions {
  conflictId?: string;
  originalSyncStatus?: EventSyncStatus;
}

const VISIBILIDAD_ESPACIO_EVENT_VALUES = {
  sin_restriccion: 0,
  solo_restringido: 1,
} as const;

const DEFAULT_PULL_LIMIT = 500;
const MAX_PULL_LIMIT = 1000;
const DEFAULT_PREFLIGHT_LIMIT = 500;
const MAX_PREFLIGHT_LIMIT = 1000;
const DEFAULT_CONFLICT_LIMIT = 100;
const MAX_CONFLICT_LIMIT = 500;

@Injectable()
export class SyncService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly eventsGateway: EventsGateway,
    private readonly syncConflictService: SyncConflictService,
    @Optional()
    private readonly categoriaEventHandler?: CategoriaEventHandler,
    @Optional()
    private readonly productoEventHandler?: ProductoEventHandler,
    @Optional()
    private readonly inventoryEventHandler?: InventoryEventHandler,
  ) {}

  async health(): Promise<SyncHealthResponseDto> {
    const latestServerSequence = await this.getLatestServerSequence();

    return {
      status: 'ok',
      latest_server_sequence: latestServerSequence,
      server_time: new Date().toISOString(),
    };
  }

  async pushEvents(body: PushEventsDto): Promise<PushEventsResponseDto> {
    if (!body || !Array.isArray(body.events)) {
      throw new BadRequestException(
        'El body debe incluir events como arreglo.',
      );
    }

    const results: PushEventResultDto[] = [];
    const acceptedEvents: EventEntity[] = [];

    for (const event of body.events) {
      const result = await this.processEvent(body.device_id, event);
      results.push(result);

      if (result.status === 'accepted') {
        const accepted = await this.dataSource
          .getRepository(EventEntity)
          .findOneBy({ eventId: result.event_id });

        if (accepted) {
          acceptedEvents.push(accepted);
        }
      }
    }

    if (acceptedEvents.length > 0) {
      this.eventsGateway.notifyEventsAvailable({
        latestServerSequence: this.maxServerSequence(acceptedEvents),
        eventTypes: [
          ...new Set(acceptedEvents.map((event) => event.eventType)),
        ],
        sourceDeviceId: body.device_id,
      });
    }

    return {
      results,
      server_time: new Date().toISOString(),
    };
  }

  async pullEvents(query: PullEventsQueryDto): Promise<PullEventsResponseDto> {
    const since = this.parseCursor(query?.since, 'since');
    const limit = this.parseLimit(query?.limit);

    const records = await this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .where('event.sync_status = :syncStatus', {
        syncStatus: EventSyncStatus.SYNCED,
      })
      .andWhere('event.server_sequence > :since', { since })
      .orderBy('event.server_sequence', 'ASC')
      .take(limit + 1)
      .getMany();

    const page = records.slice(0, limit);
    const nextCursor = page.length > 0 ? this.maxServerSequence(page) : since;

    return {
      events: page.map((event) => this.toPullEvent(event)),
      next_cursor: nextCursor,
      has_more: records.length > limit,
    };
  }

  async preflightEvents(
    body: PreflightEventsDto,
  ): Promise<PreflightEventsResponseDto> {
    if (!body || !Array.isArray(body.pending_refs)) {
      throw new BadRequestException(
        'El body debe incluir pending_refs como arreglo.',
      );
    }

    const since = this.parseCursor(
      body.last_full_pull_server_sequence,
      'last_full_pull_server_sequence',
    );
    const maxEvents = this.parsePreflightLimit(body.max_events);
    const latestServerSequence = await this.getLatestServerSequence();
    const refs = this.normalizePreflightRefs(body.pending_refs);

    if (body.pending_refs.length > 0 && refs.length === 0) {
      return {
        events: [],
        preflight_sequence: latestServerSequence,
        has_more: false,
        requires_full_pull_before_push: true,
        reason: 'missing_pending_refs',
      };
    }

    if (refs.length === 0) {
      return {
        events: [],
        preflight_sequence: latestServerSequence,
        has_more: false,
        requires_full_pull_before_push: false,
        reason: null,
      };
    }

    const query = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .distinct(true)
      .innerJoin(EventRefEntity, 'ref', 'ref.event_id = event.event_id')
      .where('event.sync_status = :syncStatus', {
        syncStatus: EventSyncStatus.SYNCED,
      })
      .andWhere('event.server_sequence > :since', { since })
      .andWhere(
        new Brackets((qb) => {
          refs.forEach((ref, index) => {
            qb.orWhere(
              `(ref.ref_type = :refType${index} AND ref.ref_id = :refId${index})`,
              {
                [`refType${index}`]: ref.type,
                [`refId${index}`]: ref.id,
              },
            );
          });
        }),
      )
      .orderBy('event.server_sequence', 'ASC')
      .take(maxEvents + 1);

    const records = await query.getMany();
    const page = records.slice(0, maxEvents);
    const hasMore = records.length > maxEvents;

    return {
      events: page.map((event) => this.toPullEvent(event)),
      preflight_sequence: latestServerSequence,
      has_more: hasMore,
      requires_full_pull_before_push: hasMore,
      reason: hasMore ? 'too_many_impacting_events' : null,
    };
  }

  async reportConflicts(
    body: ReportConflictsDto,
  ): Promise<ReportConflictsResponseDto> {
    if (!body || !Array.isArray(body.events)) {
      throw new BadRequestException(
        'El body debe incluir events como arreglo.',
      );
    }

    const results: ReportConflictResultDto[] = [];

    for (const event of body.events) {
      results.push(await this.processReportedConflict(body.device_id, event));
    }

    return {
      results,
      server_time: new Date().toISOString(),
    };
  }

  async listConflicts(
    query: ListConflictsQueryDto,
  ): Promise<ListConflictsResponseDto> {
    const limit = this.parseConflictLimit(query?.limit);
    const repository = this.dataSource.getRepository(SyncConflictEntity);
    const queryBuilder = repository
      .createQueryBuilder('conflict')
      .orderBy('conflict.updated_at_server', 'DESC')
      .take(limit);

    const requestedStatus = this.normalizeConflictStatus(query?.status);
    if (requestedStatus) {
      queryBuilder.where('conflict.status = :status', {
        status: requestedStatus,
      });
    } else {
      queryBuilder.where('conflict.status IN (:...statuses)', {
        statuses: [SyncConflictStatus.OPEN, SyncConflictStatus.ACKNOWLEDGED],
      });
    }

    if (query?.ref_type) {
      queryBuilder.andWhere('conflict.ref_type = :refType', {
        refType: query.ref_type,
      });
    }

    if (query?.ref_id) {
      queryBuilder.andWhere('conflict.ref_id = :refId', {
        refId: query.ref_id,
      });
    }

    const conflicts = await queryBuilder.getMany();
    const participants = await this.participantsForConflicts(
      conflicts.map((conflict) => conflict.conflictId),
    );

    return {
      conflicts: conflicts.map((conflict) =>
        this.toListConflict(conflict, participants.get(conflict.conflictId)),
      ),
    };
  }

  private async processEvent(
    requestDeviceId: string,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const duplicate = await this.dataSource
      .getRepository(EventEntity)
      .findOneBy({ eventId: event.event_id });

    if (duplicate) {
      return this.toResult(
        duplicate,
        'duplicate',
        duplicate.rejectionReason ?? undefined,
        { originalSyncStatus: duplicate.syncStatus },
      );
    }

    const validationError = this.validateBaseEvent(requestDeviceId, event);
    if (validationError) {
      return this.rejectedResult(event.event_id, validationError);
    }

    const isCategoryEvent =
      this.categoriaEventHandler?.supports(event.event_type) ?? false;
    const isProductEvent =
      this.productoEventHandler?.supports(event.event_type) ?? false;
    const isInventoryEvent =
      this.inventoryEventHandler?.supports(event.event_type) ?? false;
    if (
      event.event_type !== 'espacio_creado' &&
      !isCategoryEvent &&
      !isProductEvent &&
      !isInventoryEvent
    ) {
      return this.rejectedResult(
        event.event_id,
        `Evento no soportado: ${event.event_type}`,
      );
    }

    if (event.aggregate_type === 'category' && !this.categoriaEventHandler) {
      return this.rejectedResult(
        event.event_id,
        'No está registrado el handler de eventos de categoría.',
      );
    }
    if (event.aggregate_type === 'product' && !this.productoEventHandler) {
      return this.rejectedResult(
        event.event_id,
        'No está registrado el handler de eventos de producto.',
      );
    }
    if (
      event.aggregate_type === RecursoInventarioCreadoPayload.aggregateType &&
      !this.inventoryEventHandler
    ) {
      return this.rejectedResult(
        event.event_id,
        'No está registrado el handler de eventos de inventario.',
      );
    }

    try {
      return await this.dataSource.transaction((manager) => {
        if (isCategoryEvent) {
          return this.categoriaEventHandler!.apply(manager, event);
        }
        if (isProductEvent) {
          return this.productoEventHandler!.apply(manager, event);
        }
        if (isInventoryEvent) {
          return this.inventoryEventHandler!.apply(manager, event);
        }
        return this.applyEspacioCreado(manager, event);
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;

      const duplicateAfterRace = await this.dataSource
        .getRepository(EventEntity)
        .findOneBy({ eventId: event.event_id });

      if (duplicateAfterRace) {
        return this.toResult(
          duplicateAfterRace,
          'duplicate',
          duplicateAfterRace.rejectionReason ?? undefined,
          { originalSyncStatus: duplicateAfterRace.syncStatus },
        );
      }

      if (isCategoryEvent && event.event_type !== 'categoria_creada') {
        return this.rejectedResult(
          event.event_id,
          'El evento de actualización violó una restricción única.',
        );
      }

      if (isProductEvent) {
        return this.dataSource.transaction((manager) =>
          this.productoEventHandler!.saveUniqueViolationConflict(
            manager,
            event,
          ),
        );
      }
      if (isInventoryEvent) {
        return this.dataSource.transaction((manager) =>
          this.inventoryEventHandler!.saveUniqueViolationConflict(
            manager,
            event,
          ),
        );
      }

      return this.dataSource.transaction((manager) => {
        if (event.event_type === 'categoria_creada') {
          return this.categoriaEventHandler!.saveUniqueViolationConflict(
            manager,
            event,
          );
        }
        return this.saveUniqueViolationConflict(manager, event);
      });
    }
  }

  private async processReportedConflict(
    requestDeviceId: string,
    event: ReportConflictEventDto,
  ): Promise<ReportConflictResultDto> {
    const duplicate = await this.dataSource
      .getRepository(EventEntity)
      .findOneBy({ eventId: event.event_id });

    if (duplicate) {
      return this.toReportResult(
        duplicate,
        'duplicate',
        duplicate.rejectionReason ?? undefined,
        { originalSyncStatus: duplicate.syncStatus },
      );
    }

    const validationError = this.validateBaseEvent(requestDeviceId, event);
    if (validationError) {
      return this.rejectedReportResult(event.event_id, validationError);
    }

    if (
      event.event_type !== 'espacio_creado' &&
      event.event_type !== 'categoria_creada' &&
      event.event_type !== 'categoria_actualizada' &&
      event.event_type !== 'categoria_movida' &&
      event.event_type !== CategoriaEliminadaPayload.eventType &&
      event.event_type !== 'producto_creado' &&
      event.event_type !== RecursoInventarioCreadoPayload.eventType
    ) {
      return this.rejectedReportResult(
        event.event_id,
        `Evento no soportado: ${event.event_type}`,
      );
    }

    return this.dataSource.transaction((manager) =>
      this.saveReportedConflict(manager, event),
    );
  }

  private async saveReportedConflict(
    manager: EntityManager,
    event: ReportConflictEventDto,
  ): Promise<ReportConflictResultDto> {
    const reason = this.readConflictReason(event.reason);
    const refs = this.normalizeReportedRefs(event);
    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveReportedEventRefs(
      manager,
      event,
      savedEvent.serverSequence,
      refs,
    );
    const target = await this.resolveConflictTarget(manager, event, refs);
    const conflict = await this.syncConflictService.recordConflict(manager, {
      conflictType: target.conflictType,
      refType: target.refType,
      refId: target.refId,
      reason,
      losingEvent: savedEvent,
      defaultWinnerEventId: target.defaultWinnerEventId,
    });

    return this.toReportResult(savedEvent, 'conflict', reason, {
      conflictId: conflict.conflictId,
    });
  }

  private async saveUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const payload = this.parseEspacioCreadoPayload(event.payload);
    if ('error' in payload) {
      return this.saveRejectedEvent(manager, event, payload.error);
    }

    const existingByIdentification = payload.identificacion
      ? await manager.findOneBy(EspacioEntity, {
          identificacion: payload.identificacion,
        })
      : null;

    if (
      payload.identificacion &&
      existingByIdentification &&
      existingByIdentification.id !== event.aggregate_id
    ) {
      const reason = `Ya existe un espacio con identificacion ${payload.identificacion}.`;
      return this.saveConflictEvent(manager, event, payload, reason, {
        conflictType: 'unique_key_conflict',
        refType: 'espacio_identificacion',
        refId: payload.identificacion,
        defaultWinnerEventId: existingByIdentification.createdEventId,
      });
    }

    const existingById = await manager.findOneBy(EspacioEntity, {
      id: event.aggregate_id,
    });
    const reason = `El evento choco con una restriccion unica del servidor.`;

    return this.saveConflictEvent(manager, event, payload, reason, {
      conflictType: 'aggregate_id_conflict',
      refType: 'espacio',
      refId: event.aggregate_id,
      defaultWinnerEventId: existingById?.createdEventId ?? null,
    });
  }

  private async applyEspacioCreado(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const payload = this.parseEspacioCreadoPayload(event.payload);

    if ('error' in payload) {
      return this.saveRejectedEvent(manager, event, payload.error);
    }

    const existingById = await manager.findOneBy(EspacioEntity, {
      id: event.aggregate_id,
    });

    if (existingById && existingById.createdEventId !== event.event_id) {
      const reason = `Ya existe un espacio con id ${event.aggregate_id}.`;
      return this.saveConflictEvent(manager, event, payload, reason, {
        conflictType: 'aggregate_id_conflict',
        refType: 'espacio',
        refId: event.aggregate_id,
        defaultWinnerEventId: existingById.createdEventId,
      });
    }

    if (payload.identificacion) {
      const existingByIdentification = await manager.findOneBy(EspacioEntity, {
        identificacion: payload.identificacion,
      });

      if (
        existingByIdentification &&
        existingByIdentification.id !== event.aggregate_id
      ) {
        const reason = `Ya existe un espacio con identificacion ${payload.identificacion}.`;
        return this.saveConflictEvent(manager, event, payload, reason, {
          conflictType: 'unique_key_conflict',
          refType: 'espacio_identificacion',
          refId: payload.identificacion,
          defaultWinnerEventId: existingByIdentification.createdEventId,
        });
      }
    }

    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.SYNCED,
    );
    await this.saveEventRefs(
      manager,
      event,
      savedEvent.serverSequence,
      payload,
    );

    if (!existingById) {
      await manager.save(
        manager.create(EspacioEntity, {
          id: event.aggregate_id,
          nombre: payload.nombre,
          identificacion: payload.identificacion,
          visibilidad: payload.visibilidad,
          active: true,
          version: event.base_version ?? 1,
          createdEventId: event.event_id,
          lastEventId: event.event_id,
          lastServerSequence: savedEvent.serverSequence,
        }),
      );
    }

    return this.toResult(savedEvent, 'accepted');
  }

  private async saveRejectedEvent(
    manager: EntityManager,
    event: PushEventDto,
    reason: string,
  ): Promise<PushEventResultDto> {
    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.REJECTED,
      reason,
    );

    return this.toResult(savedEvent, 'rejected', reason);
  }

  private async saveConflictEvent(
    manager: EntityManager,
    event: PushEventDto,
    payload: EspacioCreadoPayload,
    reason: string,
    target: ConflictTarget,
  ): Promise<PushEventResultDto> {
    const savedEvent = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveEventRefs(
      manager,
      event,
      savedEvent.serverSequence,
      payload,
    );
    const conflict = await this.syncConflictService.recordConflict(manager, {
      conflictType: target.conflictType,
      refType: target.refType,
      refId: target.refId,
      reason,
      losingEvent: savedEvent,
      defaultWinnerEventId: target.defaultWinnerEventId,
    });

    return this.toResult(savedEvent, 'conflict', reason, {
      conflictId: conflict.conflictId,
    });
  }

  private saveEvent(
    manager: EntityManager,
    event: PushEventDto,
    syncStatus: EventSyncStatus,
    rejectionReason: string | null = null,
  ): Promise<EventEntity> {
    return manager.save(
      manager.create(EventEntity, {
        eventId: event.event_id,
        aggregateType: event.aggregate_type,
        aggregateId: event.aggregate_id,
        eventType: event.event_type,
        deviceId: event.device_id,
        userId: event.user_id,
        localSequence: event.local_sequence ?? null,
        baseServerSequence: this.toNullableString(event.base_server_sequence),
        baseVersion: event.base_version ?? null,
        createdAtLocal: new Date(event.created_at_local),
        payload: event.payload,
        syncStatus,
        rejectionReason,
      }),
    );
  }

  private async saveEventRefs(
    manager: EntityManager,
    event: PushEventDto,
    serverSequence: string,
    payload: EspacioCreadoPayload,
  ): Promise<void> {
    const refs = [
      manager.create(EventRefEntity, {
        eventRefId: randomUUID(),
        eventId: event.event_id,
        refType: 'espacio',
        refId: event.aggregate_id,
        relationship: 'affects',
        serverSequence,
        source: 'server',
      }),
    ];

    if (payload.identificacion) {
      refs.push(
        manager.create(EventRefEntity, {
          eventRefId: randomUUID(),
          eventId: event.event_id,
          refType: 'espacio_identificacion',
          refId: payload.identificacion,
          relationship: 'requires_unique',
          serverSequence,
          source: 'server',
        }),
      );
    }

    await manager.save(refs);
  }

  private async saveReportedEventRefs(
    manager: EntityManager,
    event: PushEventDto,
    serverSequence: string,
    refs: ConflictRef[],
  ): Promise<void> {
    await manager.save(
      refs.map((ref) =>
        manager.create(EventRefEntity, {
          eventRefId: randomUUID(),
          eventId: event.event_id,
          refType: ref.type,
          refId: ref.id,
          relationship: ref.relationship ?? 'affects',
          serverSequence,
          source: 'server',
        }),
      ),
    );
  }

  private normalizeReportedRefs(event: ReportConflictEventDto): ConflictRef[] {
    const refsByKey = new Map<string, ConflictRef>();

    this.addConflictRef(refsByKey, {
      type: event.aggregate_type,
      id: event.aggregate_id,
      relationship: 'affects',
    });

    for (const ref of event.refs ?? []) {
      const type = this.readReportRefType(ref);
      const id = this.readReportRefId(ref);
      this.addConflictRef(refsByKey, {
        type,
        id,
        relationship: ref.relationship ?? null,
      });
    }

    return [...refsByKey.values()];
  }

  private addConflictRef(
    refsByKey: Map<string, ConflictRef>,
    ref: ConflictRef,
  ): void {
    const type = typeof ref.type === 'string' ? ref.type.trim() : '';
    const id = typeof ref.id === 'string' ? ref.id.trim() : '';
    if (!type || !id) return;

    refsByKey.set(`${type}\u0000${id}`, {
      type,
      id,
      relationship: ref.relationship ?? null,
    });
  }

  private readReportRefType(ref: ReportConflictRefDto): string {
    if (typeof ref.type === 'string') return ref.type;
    if (typeof ref.ref_type === 'string') return ref.ref_type;
    return '';
  }

  private readReportRefId(ref: ReportConflictRefDto): string {
    if (typeof ref.id === 'string') return ref.id;
    if (typeof ref.ref_id === 'string') return ref.ref_id;
    return '';
  }

  private async resolveConflictTarget(
    manager: EntityManager,
    event: PushEventDto,
    refs: ConflictRef[],
  ): Promise<ConflictTarget> {
    const uniqueRef = refs.find(
      (ref) => ref.relationship === 'requires_unique',
    );
    const selectedRef = uniqueRef ??
      refs.find((ref) => ref.relationship === 'affects') ?? {
        type: event.aggregate_type,
        id: event.aggregate_id,
        relationship: 'affects',
      };
    const defaultWinnerEventId = await this.findSyncedWinnerEventId(
      manager,
      selectedRef.type,
      selectedRef.id,
    );

    return {
      conflictType: uniqueRef ? 'unique_key_conflict' : 'aggregate_id_conflict',
      refType: selectedRef.type,
      refId: selectedRef.id,
      defaultWinnerEventId,
    };
  }

  private async findSyncedWinnerEventId(
    manager: EntityManager,
    refType: string,
    refId: string,
  ): Promise<string | null> {
    const event = await manager
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoin(EventRefEntity, 'ref', 'ref.event_id = event.event_id')
      .where('event.sync_status = :syncStatus', {
        syncStatus: EventSyncStatus.SYNCED,
      })
      .andWhere('ref.ref_type = :refType', { refType })
      .andWhere('ref.ref_id = :refId', { refId })
      .orderBy('event.server_sequence', 'ASC')
      .getOne();

    return event?.eventId ?? null;
  }

  private readConflictReason(reason: string | null | undefined): string {
    if (typeof reason === 'string' && reason.trim() !== '') {
      return reason.trim();
    }

    return 'Conflicto detectado localmente por el dispositivo.';
  }

  private validateBaseEvent(
    requestDeviceId: string,
    event: PushEventDto,
  ): string | null {
    if (!event?.event_id) return 'event_id es obligatorio.';
    if (!event.aggregate_type) return 'aggregate_type es obligatorio.';
    if (!event.aggregate_id) return 'aggregate_id es obligatorio.';
    if (!event.event_type) return 'event_type es obligatorio.';
    if (!event.device_id) return 'device_id es obligatorio.';
    if (!event.user_id) return 'user_id es obligatorio.';
    if (!event.created_at_local) return 'created_at_local es obligatorio.';
    if (!event.payload || typeof event.payload !== 'object') {
      return 'payload debe ser un objeto.';
    }
    if (requestDeviceId && requestDeviceId !== event.device_id) {
      return 'device_id del request no coincide con el evento.';
    }
    if (Number.isNaN(new Date(event.created_at_local).getTime())) {
      return 'created_at_local no es una fecha valida.';
    }
    if (
      event.event_type === 'espacio_creado' &&
      event.aggregate_type !== 'espacio'
    ) {
      return 'espacio_creado debe usar aggregate_type espacio.';
    }
    if (
      (event.event_type === 'categoria_creada' ||
        event.event_type === 'categoria_actualizada' ||
        event.event_type === 'categoria_movida' ||
        event.event_type === CategoriaEliminadaPayload.eventType) &&
      event.aggregate_type !== 'category'
    ) {
      return `${event.event_type} debe usar aggregate_type category.`;
    }
    if (
      event.event_type === 'producto_creado' &&
      event.aggregate_type !== 'product'
    ) {
      return 'producto_creado debe usar aggregate_type product.';
    }
    if (
      event.event_type === RecursoInventarioCreadoPayload.eventType &&
      event.aggregate_type !== RecursoInventarioCreadoPayload.aggregateType
    ) {
      return 'recurso_inventario_creado debe usar aggregate_type inventory_item.';
    }

    return null;
  }

  private parseEspacioCreadoPayload(
    payload: Record<string, unknown>,
  ): EspacioCreadoPayload | { error: string } {
    if (typeof payload.nombre !== 'string' || payload.nombre.trim() === '') {
      return { error: 'payload.nombre es obligatorio.' };
    }

    if (
      payload.identificacion !== null &&
      payload.identificacion !== undefined &&
      typeof payload.identificacion !== 'string'
    ) {
      return { error: 'payload.identificacion debe ser string o null.' };
    }

    const visibilidad = this.parseVisibilidadEspacio(payload.visibilidad);

    if ('error' in visibilidad) {
      return { error: visibilidad.error };
    }

    return {
      nombre: payload.nombre.trim(),
      identificacion:
        typeof payload.identificacion === 'string' &&
        payload.identificacion.trim() !== ''
          ? payload.identificacion.trim()
          : null,
      visibilidad: visibilidad.value,
    };
  }

  private parseVisibilidadEspacio(
    value: unknown,
  ): { value: number } | { error: string } {
    if (typeof value === 'string') {
      const normalized = value.trim();

      if (normalized in VISIBILIDAD_ESPACIO_EVENT_VALUES) {
        return {
          value:
            VISIBILIDAD_ESPACIO_EVENT_VALUES[
              normalized as keyof typeof VISIBILIDAD_ESPACIO_EVENT_VALUES
            ],
        };
      }

      return {
        error: `payload.visibilidad desconocida: ${value}.`,
      };
    }

    if (typeof value === 'number' && Number.isInteger(value)) {
      if (value === 0 || value === 1) {
        return { value };
      }

      return {
        error: `Indice legado de payload.visibilidad desconocido: ${value}.`,
      };
    }

    return {
      error:
        'payload.visibilidad debe ser sin_restriccion, solo_restringido, 0 o 1.',
    };
  }

  private toResult(
    event: EventEntity,
    status: PushEventResultDto['status'],
    reason?: string,
    options: EventResultOptions = {},
  ): PushEventResultDto {
    return {
      event_id: event.eventId,
      status,
      server_sequence: Number(event.serverSequence),
      created_at_server: event.createdAtServer.toISOString(),
      ...(reason ? { reason } : {}),
      ...(options.conflictId ? { conflict_id: options.conflictId } : {}),
      ...(options.originalSyncStatus
        ? { original_sync_status: options.originalSyncStatus }
        : {}),
    };
  }

  private toReportResult(
    event: EventEntity,
    status: ReportConflictResultDto['status'],
    reason?: string,
    options: EventResultOptions = {},
  ): ReportConflictResultDto {
    return {
      event_id: event.eventId,
      status,
      server_sequence: Number(event.serverSequence),
      created_at_server: event.createdAtServer.toISOString(),
      ...(reason ? { reason } : {}),
      ...(options.conflictId ? { conflict_id: options.conflictId } : {}),
      ...(options.originalSyncStatus
        ? { original_sync_status: options.originalSyncStatus }
        : {}),
    };
  }

  private toPullEvent(event: EventEntity): PullEventDto {
    return {
      event_id: event.eventId,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      event_type: event.eventType,
      device_id: event.deviceId,
      user_id: event.userId,
      local_sequence: event.localSequence,
      server_sequence: Number(event.serverSequence),
      base_server_sequence: this.toNullableNumber(event.baseServerSequence),
      base_version: event.baseVersion,
      created_at_local: event.createdAtLocal.toISOString(),
      created_at_server: event.createdAtServer.toISOString(),
      payload: event.payload,
      sync_status: 'synced',
    };
  }

  private rejectedResult(
    eventId: string | undefined,
    reason: string,
  ): PushEventResultDto {
    return {
      event_id: eventId ?? '',
      status: 'rejected',
      server_sequence: null,
      created_at_server: null,
      reason,
    };
  }

  private rejectedReportResult(
    eventId: string | undefined,
    reason: string,
  ): ReportConflictResultDto {
    return {
      event_id: eventId ?? '',
      status: 'rejected',
      server_sequence: null,
      created_at_server: null,
      reason,
    };
  }

  private maxServerSequence(events: EventEntity[]): number {
    return Math.max(
      ...events.map((event) => Number(event.serverSequence)).filter(Boolean),
    );
  }

  private async participantsForConflicts(
    conflictIds: string[],
  ): Promise<Map<string, SyncConflictParticipantEntity[]>> {
    const participantsByConflict = new Map<
      string,
      SyncConflictParticipantEntity[]
    >();
    if (conflictIds.length === 0) return participantsByConflict;

    const participants = await this.dataSource
      .getRepository(SyncConflictParticipantEntity)
      .find({
        where: { conflictId: In(conflictIds) },
        order: {
          conflictId: 'ASC',
          createdAtServer: 'ASC',
        },
      });

    for (const participant of participants) {
      const group = participantsByConflict.get(participant.conflictId) ?? [];
      group.push(participant);
      participantsByConflict.set(participant.conflictId, group);
    }

    return participantsByConflict;
  }

  private toListConflict(
    conflict: SyncConflictEntity,
    participants: SyncConflictParticipantEntity[] = [],
  ): ListConflictDto {
    return {
      conflict_id: conflict.conflictId,
      conflict_type: conflict.conflictType,
      ref_type: conflict.refType,
      ref_id: conflict.refId,
      status: conflict.status,
      default_winner_event_id: conflict.defaultWinnerEventId,
      resolution_event_id: conflict.resolutionEventId,
      reason: conflict.reason,
      created_at_server: conflict.createdAtServer.toISOString(),
      updated_at_server: conflict.updatedAtServer.toISOString(),
      participants: participants.map((participant) =>
        this.toListParticipant(participant),
      ),
    };
  }

  private toListParticipant(
    participant: SyncConflictParticipantEntity,
  ): ListConflictParticipantDto {
    return {
      participant_id: participant.participantId,
      event_id: participant.eventId,
      participant_role: participant.participantRole,
      aggregate_type: participant.aggregateType,
      aggregate_id: participant.aggregateId,
      event_type: participant.eventType,
      sync_status: participant.syncStatus,
      server_sequence: this.toNullableNumber(participant.serverSequence),
      reason: participant.reason,
      created_at_server: participant.createdAtServer.toISOString(),
    };
  }

  private async getLatestServerSequence(): Promise<number> {
    const result = await this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .select('MAX(event.server_sequence)', 'latest_server_sequence')
      .where('event.sync_status = :syncStatus', {
        syncStatus: EventSyncStatus.SYNCED,
      })
      .getRawOne<{ latest_server_sequence: string | number | null }>();

    return Number(result?.latest_server_sequence ?? 0);
  }

  private toNullableString(value: string | number | null | undefined) {
    return value === null || value === undefined ? null : String(value);
  }

  private toNullableNumber(value: string | number | null | undefined) {
    if (value === null || value === undefined) return null;
    return Number(value);
  }

  private parseCursor(
    value: string | number | null | undefined,
    fieldName: string,
  ): number {
    if (value === null || value === undefined || value === '') return 0;

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new BadRequestException(`${fieldName} debe ser un entero >= 0.`);
    }

    return parsed;
  }

  private parseLimit(value: string | number | null | undefined): number {
    if (value === null || value === undefined || value === '') {
      return DEFAULT_PULL_LIMIT;
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('limit debe ser un entero > 0.');
    }

    return Math.min(parsed, MAX_PULL_LIMIT);
  }

  private parseConflictLimit(
    value: string | number | null | undefined,
  ): number {
    if (value === null || value === undefined || value === '') {
      return DEFAULT_CONFLICT_LIMIT;
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('limit debe ser un entero > 0.');
    }

    return Math.min(parsed, MAX_CONFLICT_LIMIT);
  }

  private parsePreflightLimit(
    value: string | number | null | undefined,
  ): number {
    if (value === null || value === undefined || value === '') {
      return DEFAULT_PREFLIGHT_LIMIT;
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new BadRequestException('max_events debe ser un entero > 0.');
    }

    return Math.min(parsed, MAX_PREFLIGHT_LIMIT);
  }

  private normalizeConflictStatus(
    value: string | SyncConflictStatus | null | undefined,
  ): SyncConflictStatus | null {
    if (!value) return null;

    const normalized = String(value).trim();
    const statuses = Object.values(SyncConflictStatus);
    if (statuses.includes(normalized as SyncConflictStatus)) {
      return normalized as SyncConflictStatus;
    }

    throw new BadRequestException('status de conflicto desconocido.');
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    return 'code' in error && error.code === '23505';
  }

  private normalizePreflightRefs(
    pendingRefs: PreflightEventsDto['pending_refs'],
  ): PreflightEventRefDto[] {
    const refsByKey = new Map<string, PreflightEventRefDto>();

    for (const pendingRef of pendingRefs) {
      this.addPreflightRef(refsByKey, {
        type: pendingRef.aggregate_type,
        id: pendingRef.aggregate_id,
        relationship: 'affects',
      });

      for (const ref of pendingRef.refs ?? []) {
        this.addPreflightRef(refsByKey, ref);
      }
    }

    return [...refsByKey.values()];
  }

  private addPreflightRef(
    refsByKey: Map<string, PreflightEventRefDto>,
    ref: PreflightEventRefDto,
  ): void {
    const type = typeof ref.type === 'string' ? ref.type.trim() : '';
    const id = typeof ref.id === 'string' ? ref.id.trim() : '';
    if (!type || !id) return;

    refsByKey.set(`${type}\u0000${id}`, {
      type,
      id,
      relationship: ref.relationship ?? null,
    });
  }
}
