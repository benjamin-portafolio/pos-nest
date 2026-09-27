import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { FinancialCategoryEntity } from '../entities/financial-category.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { CategoriaFinancieraCreadaPayload } from './payloads/categoria-financiera-creada.payload';
import { requiredUuidV4 } from './payloads/inventory-movement.payload';
import { SyncConflictService } from './sync-conflict.service';

/**
 * Alta de categoría financiera (contrato §6.3). Categoría nueva de un solo
 * evento: `base_version=1`, `base_server_sequence=null`. Payload/sobre
 * inválidos → `rejected` sin guardar evento; colisión de identidad → evento
 * `conflict` + refs canónicas + `recordConflict`, sin sobrescribir la fila.
 */
@Injectable()
export class FinancialCategoryEventHandler {
  constructor(private readonly conflicts: SyncConflictService) {}

  supports(type: string): boolean {
    return type === CategoriaFinancieraCreadaPayload.eventType;
  }

  async apply(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    let p: CategoriaFinancieraCreadaPayload;
    try {
      requiredUuidV4(e.event_id, 'event_id');
      requiredUuidV4(e.aggregate_id, 'category_id');
      if (
        e.aggregate_type !== CategoriaFinancieraCreadaPayload.aggregateType ||
        e.base_version !== 1 ||
        e.base_server_sequence != null
      ) {
        throw new Error('Sobre de categoría financiera inválido.');
      }
      p = CategoriaFinancieraCreadaPayload.fromJson(e.payload);
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
    const existing = await manager.findOneBy(FinancialCategoryEntity, {
      id: e.aggregate_id,
    });
    if (existing) {
      return this.saveConflict(
        manager,
        e,
        'Ya existe una categoría financiera con este id.',
        existing.createdEventId,
      );
    }

    const saved = await this.saveEvent(
      manager,
      { ...e, payload: p.toJson() },
      EventSyncStatus.SYNCED,
    );
    await manager.insert(FinancialCategoryEntity, {
      id: e.aggregate_id,
      name: p.name,
      direction: p.direction,
      nature: p.nature,
      active: true,
      version: 1,
      createdEventId: e.event_id,
      lastEventId: e.event_id,
      lastServerSequence: saved.serverSequence,
    });
    await this.saveRefs(manager, saved);
    return this.result(saved, 'accepted');
  }

  async saveUniqueViolationConflict(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    const existing = await manager.findOneBy(FinancialCategoryEntity, {
      id: e.aggregate_id,
    });
    return this.saveConflict(
      manager,
      e,
      'Identidad de categoría financiera ya registrada.',
      existing?.createdEventId ?? null,
    );
  }

  private async saveConflict(
    manager: EntityManager,
    e: PushEventDto,
    reason: string,
    winner: string | null,
  ): Promise<PushEventResultDto> {
    const saved = await this.saveEvent(
      manager,
      e,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveRefs(manager, saved);
    const conflict = await this.conflicts.recordConflict(manager, {
      conflictType: 'financial_category_identity',
      refType: 'financial_category',
      refId: e.aggregate_id,
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
  ): Promise<void> {
    await manager.insert(EventRefEntity, {
      eventRefId: randomUUID(),
      eventId: e.eventId,
      serverSequence: e.serverSequence,
      refType: CategoriaFinancieraCreadaPayload.aggregateType,
      refId: e.aggregateId,
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
