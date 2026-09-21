import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { ClienteEntity } from '../entities/cliente.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { ClienteCreadoPayload } from './payloads/cliente-creado.payload';
import { requiredUuidV4 } from './payloads/inventory-movement.payload';
import { SyncConflictService } from './sync-conflict.service';

@Injectable()
export class ClienteEventHandler {
  constructor(private readonly conflicts: SyncConflictService) {}
  supports(type: string): boolean {
    return type === ClienteCreadoPayload.eventType;
  }

  async apply(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    try {
      requiredUuidV4(event.event_id, 'event_id');
      requiredUuidV4(event.aggregate_id, 'cliente_id');
    } catch (error) {
      return {
        event_id: event.event_id,
        status: 'rejected',
        server_sequence: null,
        created_at_server: null,
        reason: (error as Error).message,
      };
    }
    let payload: ClienteCreadoPayload;
    try {
      if (
        event.aggregate_type !== ClienteCreadoPayload.aggregateType ||
        event.base_version !== 1 ||
        event.base_server_sequence != null
      ) {
        throw new Error(
          'El alta del cliente requiere versión 1 y ninguna base oficial.',
        );
      }
      payload = ClienteCreadoPayload.fromJson(event.payload);
    } catch (error) {
      const saved = await this.saveEvent(
        manager,
        event,
        EventSyncStatus.REJECTED,
        (error as Error).message,
      );
      return this.result(saved, 'rejected');
    }
    // Serializa altas concurrentes de la misma identidad, incluso antes de existir la fila.
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [ClienteCreadoPayload.aggregateType + ':' + event.aggregate_id],
    );
    const duplicate = await manager.findOneBy(EventEntity, {
      eventId: event.event_id,
    });
    if (duplicate) return this.result(duplicate, 'duplicate');
    const existing = await manager.findOneBy(ClienteEntity, {
      id: event.aggregate_id,
    });
    if (existing)
      return this.saveConflict(manager, event, existing.createdEventId);

    const saved = await this.saveEvent(
      manager,
      { ...event, payload: payload.toJson() },
      EventSyncStatus.SYNCED,
    );
    await manager.insert(ClienteEntity, {
      id: event.aggregate_id,
      nombre: payload.nombre,
      telefono: payload.telefono,
      active: true,
      version: 1,
      createdEventId: event.event_id,
      lastEventId: event.event_id,
      lastServerSequence: saved.serverSequence,
    });
    await this.saveRef(manager, saved);
    return this.result(saved, 'accepted');
  }

  async saveUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const existing = await manager.findOneBy(ClienteEntity, {
      id: event.aggregate_id,
    });
    return this.saveConflict(manager, event, existing?.createdEventId ?? null);
  }

  private async saveConflict(
    manager: EntityManager,
    event: PushEventDto,
    winner: string | null,
  ): Promise<PushEventResultDto> {
    const reason = `Ya existe un cliente con id ${event.aggregate_id}.`;
    const saved = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveRef(manager, saved);
    const conflict = await this.conflicts.recordConflict(manager, {
      conflictType: 'aggregate_id_conflict',
      refType: ClienteCreadoPayload.aggregateType,
      refId: event.aggregate_id,
      reason,
      losingEvent: saved,
      defaultWinnerEventId: winner,
    });
    return {
      ...this.result(saved, 'conflict'),
      conflict_id: conflict.conflictId,
    };
  }

  private saveEvent(
    manager: EntityManager,
    e: PushEventDto,
    status: EventSyncStatus,
    reason: string | null = null,
  ): Promise<EventEntity> {
    return manager.save(
      manager.create(EventEntity, {
        eventId: e.event_id,
        aggregateType: e.aggregate_type,
        aggregateId: e.aggregate_id,
        eventType: e.event_type,
        deviceId: e.device_id,
        userId: e.user_id,
        localSequence: e.local_sequence ?? null,
        baseVersion: e.base_version ?? null,
        baseServerSequence:
          e.base_server_sequence == null
            ? null
            : String(e.base_server_sequence),
        createdAtLocal: new Date(e.created_at_local),
        payload: e.payload,
        syncStatus: status,
        rejectionReason: reason,
      }),
    );
  }

  private async saveRef(
    manager: EntityManager,
    event: EventEntity,
  ): Promise<void> {
    await manager.insert(EventRefEntity, {
      eventRefId: randomUUID(),
      eventId: event.eventId,
      serverSequence: event.serverSequence,
      refType: ClienteCreadoPayload.aggregateType,
      refId: event.aggregateId,
      relationship: 'affects',
      source: 'server',
    });
  }

  private result(
    e: EventEntity,
    status: PushEventResultDto['status'],
  ): PushEventResultDto {
    return {
      event_id: e.eventId,
      status,
      server_sequence: Number(e.serverSequence),
      created_at_server: e.createdAtServer.toISOString(),
      ...(e.rejectionReason ? { reason: e.rejectionReason } : {}),
      ...(status === 'duplicate' ? { original_sync_status: e.syncStatus } : {}),
    };
  }
}
