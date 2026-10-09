import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { SupplierEntity } from '../entities/supplier.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { ProveedorCreadoPayload } from './payloads/proveedor-creado.payload';
import { ProveedorActualizadoPayload } from './payloads/proveedor-actualizado.payload';
import { SupplierJson } from './payloads/supplier-json';
import {
  supplierEnvelopeError,
  supplierBaseSequence,
} from './payloads/supplier-event-envelope';
import { supplierDuplicateMatches } from './payloads/supplier-event-identity';
import { SyncConflictService } from './sync-conflict.service';

@Injectable()
export class ProveedorEventHandler {
  constructor(private readonly conflicts: SyncConflictService) {}
  supports(type: string): boolean {
    return (
      type === ProveedorCreadoPayload.eventType ||
      type === ProveedorActualizadoPayload.eventType
    );
  }

  async apply(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    if (!this.supports(event.event_type))
      return this.rejected(event.event_id, 'Evento de proveedor no soportado.');
    const envelopeError = supplierEnvelopeError(event);
    if (envelopeError) return this.rejected(event.event_id, envelopeError);
    event = {
      ...event,
      event_id: SupplierJson.uuid(event.event_id, 'event_id'),
      aggregate_id: SupplierJson.uuid(event.aggregate_id, 'aggregate_id'),
    };
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['event:' + event.event_id.toLowerCase()],
    );
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['supplier:' + event.aggregate_id],
    );
    const prior = await manager.findOneBy(EventEntity, {
      eventId: event.event_id,
    });
    if (prior)
      return supplierDuplicateMatches(event, prior)
        ? this.result(prior, 'duplicate')
        : this.rejected(
            event.event_id,
            'El event_id ya existe con otro contenido.',
          );
    if (event.event_type === ProveedorActualizadoPayload.eventType)
      return this.applyUpdate(manager, event);
    let payload: ProveedorCreadoPayload;
    try {
      if (
        event.aggregate_type !== ProveedorCreadoPayload.aggregateType ||
        event.base_version !== 1 ||
        event.base_server_sequence != null
      ) {
        throw new Error(
          'El alta del proveedor requiere versión 1 y ninguna base oficial.',
        );
      }
      payload = ProveedorCreadoPayload.fromJson(event.payload);
    } catch (error) {
      const saved = await this.saveEvent(
        manager,
        event,
        EventSyncStatus.REJECTED,
        (error as Error).message,
      );
      return this.result(saved, 'rejected');
    }
    const existing = await manager.findOneBy(SupplierEntity, {
      id: event.aggregate_id,
    });
    if (existing)
      return this.saveConflict(
        manager,
        { ...event, payload: payload.toJson() },
        existing.createdEventId,
      );

    const saved = await this.saveEvent(
      manager,
      { ...event, payload: payload.toJson() },
      EventSyncStatus.SYNCED,
    );
    await manager.insert(SupplierEntity, {
      id: event.aggregate_id,
      name: payload.name,
      phone: payload.phone,
      notes: payload.notes,
      active: true,
      version: 1,
      createdEventId: event.event_id,
      lastEventId: event.event_id,
      lastServerSequence: saved.serverSequence,
    });
    await this.saveRef(manager, saved);
    return this.result(saved, 'accepted');
  }

  private async applyUpdate(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    let payload: ProveedorActualizadoPayload;
    try {
      if (
        event.aggregate_type !== ProveedorActualizadoPayload.aggregateType ||
        !Number.isInteger(event.base_version) ||
        event.base_version! < 1
      ) {
        throw new Error('Base de proveedor inválida.');
      }
      payload = ProveedorActualizadoPayload.fromJson(event.payload);
    } catch (error) {
      return this.result(
        await this.saveEvent(
          manager,
          event,
          EventSyncStatus.REJECTED,
          (error as Error).message,
        ),
        'rejected',
      );
    }
    const current = await manager.findOneBy(SupplierEntity, {
      id: event.aggregate_id,
    });
    const base = await manager.findOneBy(EventEntity, {
      eventId: payload.baseEventId,
    });
    if (
      !current ||
      !current.active ||
      current.lastEventId !== payload.baseEventId ||
      current.version !== event.base_version ||
      current.name !== payload.before.name ||
      current.phone !== payload.before.phone ||
      current.notes !== payload.before.notes ||
      !base ||
      base.syncStatus !== EventSyncStatus.SYNCED ||
      base.aggregateId !== event.aggregate_id ||
      base.aggregateType !== ProveedorActualizadoPayload.aggregateType ||
      !this.supports(base.eventType) ||
      current.lastServerSequence !== base.serverSequence ||
      (event.base_server_sequence != null &&
        supplierBaseSequence(event.base_server_sequence) !==
          Number(base.serverSequence))
    ) {
      return this.saveConflict(
        manager,
        { ...event, payload: payload.toJson() },
        current?.lastEventId ?? null,
        'El proveedor cambió desde la base de la edición.',
        'stale_base_conflict',
      );
    }
    const saved = await this.saveEvent(
      manager,
      { ...event, payload: payload.toJson() },
      EventSyncStatus.SYNCED,
    );
    await manager.update(
      SupplierEntity,
      { id: current.id },
      {
        name: payload.after.name,
        phone: payload.after.phone,
        notes: payload.after.notes,
        version: current.version + 1,
        lastEventId: event.event_id,
        lastServerSequence: saved.serverSequence,
      },
    );
    await this.saveRef(manager, saved);
    return this.result(saved, 'accepted');
  }

  async saveUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const existing = await manager.findOneBy(SupplierEntity, {
      id: event.aggregate_id,
    });
    return this.saveConflict(manager, event, existing?.createdEventId ?? null);
  }

  private async saveConflict(
    manager: EntityManager,
    event: PushEventDto,
    winner: string | null,
    reason = `Ya existe un proveedor con id ${event.aggregate_id}.`,
    conflictType = 'aggregate_id_conflict',
  ): Promise<PushEventResultDto> {
    const saved = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveRef(manager, saved);
    const conflict = await this.conflicts.recordConflict(manager, {
      conflictType,
      refType: ProveedorCreadoPayload.aggregateType,
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
      refType: ProveedorCreadoPayload.aggregateType,
      refId: event.aggregateId,
      relationship: 'affects',
      source: 'server',
    });
  }

  private rejected(eventId: string, reason: string): PushEventResultDto {
    return {
      event_id: eventId,
      status: 'rejected',
      server_sequence: null,
      created_at_server: null,
      reason,
    };
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
