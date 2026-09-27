import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { FinancialCategoryEntity } from '../entities/financial-category.entity';
import { FinancialEntryEntity } from '../entities/financial-entry.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { requiredUuidV4 } from './payloads/inventory-movement.payload';
import { MovimientoFinancieroRegistradoPayload } from './payloads/movimiento-financiero-registrado.payload';
import { SyncConflictService } from './sync-conflict.service';

const IDENTITY_REASON = 'Identidad de registro financiero ya registrada.';
const DEPENDENCY_REASON =
  'La categoría del registro no está disponible en el servidor.';
const SNAPSHOT_REASON =
  'La clasificación del registro no coincide con la categoría oficial.';

/**
 * Registro de ingreso/gasto adicional (contrato §6.4). Payload/sobre inválidos
 * → `rejected` sin guardar evento. El registro exige su categoría oficial: la
 * proyección debe existir, su `created_event_id` debe ser `category_event_id`
 * y ese evento debe estar `synced`. El servidor nunca crea la categoría ni
 * modifica su versión. Colisión de identidad o dependencia → evento `conflict`
 * + refs canónicas + `recordConflict`, sin escribir proyección.
 */
@Injectable()
export class FinancialEntryEventHandler {
  constructor(private readonly conflicts: SyncConflictService) {}

  supports(type: string): boolean {
    return type === MovimientoFinancieroRegistradoPayload.eventType;
  }

  async apply(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    let p: MovimientoFinancieroRegistradoPayload;
    try {
      requiredUuidV4(e.event_id, 'event_id');
      requiredUuidV4(e.aggregate_id, 'entry_id');
      if (
        e.aggregate_type !==
          MovimientoFinancieroRegistradoPayload.aggregateType ||
        e.base_version !== 1 ||
        e.base_server_sequence != null
      ) {
        throw new Error('Sobre de registro financiero inválido.');
      }
      p = MovimientoFinancieroRegistradoPayload.fromJson(e.payload);
    } catch (error) {
      return {
        event_id: e.event_id,
        status: 'rejected',
        server_sequence: null,
        created_at_server: null,
        reason: (error as Error).message,
      };
    }
    const duplicate = await manager.findOneBy(EventEntity, {
      eventId: e.event_id,
    });
    if (duplicate) return this.result(duplicate, 'duplicate');
    if (await manager.existsBy(FinancialEntryEntity, { id: e.aggregate_id })) {
      return this.saveConflict(
        manager,
        e,
        p,
        IDENTITY_REASON,
        'financial_entry_identity',
        null,
      );
    }
    const category = await manager.findOneBy(FinancialCategoryEntity, {
      id: p.categoryId,
    });
    const dependency = await manager.findOneBy(EventEntity, {
      eventId: p.categoryEventId,
    });
    if (
      !category ||
      category.createdEventId !== p.categoryEventId ||
      !dependency ||
      dependency.syncStatus !== EventSyncStatus.SYNCED
    ) {
      return this.saveConflict(
        manager,
        e,
        p,
        DEPENDENCY_REASON,
        'financial_entry_dependency',
        category?.createdEventId ?? null,
      );
    }
    if (p.direction !== category.direction || p.nature !== category.nature) {
      return this.saveConflict(
        manager,
        e,
        p,
        SNAPSHOT_REASON,
        'financial_entry_snapshot',
        category.createdEventId,
      );
    }

    const saved = await this.saveEvent(
      manager,
      { ...e, payload: p.toJson() },
      EventSyncStatus.SYNCED,
    );
    await manager.insert(FinancialEntryEntity, {
      id: e.aggregate_id,
      categoryId: p.categoryId,
      categoryNameSnapshot: p.categoryNameSnapshot,
      direction: p.direction,
      nature: p.nature,
      amountMinor: String(p.amountMinor),
      currency: 'MXN',
      method: p.method,
      occurredAtMs: String(p.occurredAtMs),
      notes: p.notes,
      reference: p.reference,
      active: true,
      version: 1,
      createdEventId: e.event_id,
      lastEventId: e.event_id,
      lastServerSequence: saved.serverSequence,
    });
    await this.saveRefs(manager, saved, p);
    return this.result(saved, 'accepted');
  }

  async saveUniqueViolationConflict(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    const p = MovimientoFinancieroRegistradoPayload.fromJson(e.payload);
    return this.saveConflict(
      manager,
      e,
      p,
      IDENTITY_REASON,
      'financial_entry_identity',
      null,
    );
  }

  private async saveConflict(
    manager: EntityManager,
    e: PushEventDto,
    p: MovimientoFinancieroRegistradoPayload,
    reason: string,
    conflictType: string,
    winner: string | null,
  ): Promise<PushEventResultDto> {
    const saved = await this.saveEvent(
      manager,
      e,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveRefs(manager, saved, p);
    const conflict = await this.conflicts.recordConflict(manager, {
      conflictType,
      refType: 'financial_category',
      refId: p.categoryId,
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
        baseVersion: 1,
        baseServerSequence: null,
        createdAtLocal: new Date(e.created_at_local),
        payload: e.payload,
        syncStatus: status,
        rejectionReason: reason,
      }),
    );
  }

  private async saveRefs(
    manager: EntityManager,
    e: EventEntity,
    p: MovimientoFinancieroRegistradoPayload,
  ): Promise<void> {
    await manager.insert(
      EventRefEntity,
      [
        {
          refType: MovimientoFinancieroRegistradoPayload.aggregateType,
          refId: e.aggregateId,
          relationship: 'affects',
        },
        {
          refType: 'financial_category',
          refId: p.categoryId,
          relationship: 'uses',
        },
      ].map((ref) => ({
        ...ref,
        eventRefId: randomUUID(),
        eventId: e.eventId,
        serverSequence: e.serverSequence,
        source: 'server',
      })),
    );
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
