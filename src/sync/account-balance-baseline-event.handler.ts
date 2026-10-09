import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { AccountBalanceBaselineEntity } from '../entities/account-balance-baseline.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { cashDuplicateMatches } from './payloads/cash-event-identity';
import { requiredUuidV4 } from './payloads/inventory-movement.payload';
import { SaldoCuentaInicialDeclaradoPayload } from './payloads/saldo-cuenta-inicial-declarado.payload';
import { SyncConflictService } from './sync-conflict.service';

const SLOT_REASON =
  'El saldo inicial de la cuenta ya fue declarado y es inmutable.';
const IDENTITY_REASON = 'Esta identidad de saldo inicial ya fue utilizada.';

/**
 * Saldo inicial declarado de la cuenta bancaria (contrato de la Fase 3).
 *
 * Hecho único e inmutable, no una sesión: no abre ni cierra nada y no toca caja.
 * Envelope o payload inválidos → `rejected` sin guardar evento. El slot único es
 * GLOBAL: se resuelve con un `refId` constante (`account_balance_slot`/`unica`)
 * en `requires_unique`, sin `account_id` y sin colisión por terminal, así que la
 * segunda declaración se conserva como `conflict` con su payload intacto y la
 * primera fila no se toca.
 *
 * `amount_minor` admite negativo de forma deliberada: una cuenta sobregirada es
 * una declaración legítima y recortarla a cero corrompería el estimado.
 */
@Injectable()
export class AccountBalanceBaselineEventHandler {
  constructor(private readonly conflicts: SyncConflictService) {}

  supports(type: string): boolean {
    return type === SaldoCuentaInicialDeclaradoPayload.eventType;
  }

  async apply(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    let p: SaldoCuentaInicialDeclaradoPayload;
    try {
      requiredUuidV4(e.event_id, 'event_id');
      requiredUuidV4(e.aggregate_id, 'baseline_id');
      if (
        e.aggregate_type !==
          SaldoCuentaInicialDeclaradoPayload.aggregateType ||
        e.base_version !== 1 ||
        e.base_server_sequence != null
      ) {
        throw new Error('Sobre de saldo inicial inválido.');
      }
      p = SaldoCuentaInicialDeclaradoPayload.fromJson(e.payload);
    } catch (error) {
      return {
        event_id: e.event_id,
        status: 'rejected',
        server_sequence: null,
        created_at_server: null,
        reason: (error as Error).message,
      };
    }
    // La misma exclusión para el slot y para la identidad, incluso sin fila aún.
    await this.lock(manager, SaldoCuentaInicialDeclaradoPayload.slotRefType);
    await this.lock(manager, 'baseline:' + e.aggregate_id);
    const duplicate = await manager.findOneBy(EventEntity, {
      eventId: e.event_id,
    });
    if (duplicate) {
      return cashDuplicateMatches(e, duplicate)
        ? this.result(duplicate, 'duplicate')
        : this.rejected(e, 'El event_id ya existe con otro contenido.');
    }
    const dependency = await this.dependencies(manager, e, p);
    if (dependency) return dependency;
    const baseline = await manager.findOneBy(AccountBalanceBaselineEntity, {
      id: e.aggregate_id,
    });
    if (baseline) {
      return this.saveConflict(manager, e, IDENTITY_REASON, baseline.id);
    }
    const declared = await manager.findOne(
      AccountBalanceBaselineEntity,
      { where: {}, order: { createdAtServer: 'ASC' } },
    );
    if (declared) {
      return this.saveConflict(manager, e, SLOT_REASON, declared.id);
    }
    const saved = await this.saveEvent(
      manager,
      { ...e, payload: p.toJson() },
      EventSyncStatus.SYNCED,
    );
    await manager.insert(AccountBalanceBaselineEntity, {
      id: e.aggregate_id,
      deviceId: e.device_id,
      declaredByUserId: e.user_id,
      amountMinor: String(p.amountMinor),
      asOfMs: String(p.asOfMs),
      active: true,
      version: 1,
      createdEventId: e.event_id,
      lastEventId: e.event_id,
      lastServerSequence: saved.serverSequence,
    });
    await this.saveRefs(manager, saved);
    return this.result(saved, 'accepted');
  }

  /**
   * Carrera de la exclusividad: si dos declaraciones llegan a la vez,
   * la perdedora choca con la restricción y se conserva como `conflict` en vez
   * de reventar la transacción. La fila ganadora nunca se modifica.
   */
  async saveUniqueViolationConflict(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    const declared = await manager.findOne(
      AccountBalanceBaselineEntity,
      { order: { createdAtServer: 'ASC' } },
    );
    return this.saveConflict(
      manager,
      e,
      SLOT_REASON,
      declared?.id ?? e.aggregate_id,
    );
  }

  private async lock(manager: EntityManager, key: string): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['bank:' + key],
    );
  }

  /**
   * El hecho no tiene predecesor causal: `dependencyEventIds` viene vacío y este
   * lazo no tiene a qué entrar. Se conserva la ruta `pending` por simetría con
   * caja, donde una dependencia ausente o no sincronizada devuelve `pending` sin
   * crear fila en `events`; aquí es estructuralmente inalcanzable mientras el
   * payload no declare dependencias. Queda anotado en la Bitácora del plan.
   */
  private async dependencies(
    manager: EntityManager,
    e: PushEventDto,
    p: SaldoCuentaInicialDeclaradoPayload,
  ): Promise<PushEventResultDto | null> {
    for (const id of p.dependencyEventIds) {
      const dep = await manager.findOneBy(EventEntity, { eventId: id });
      if (!dep || dep.syncStatus === EventSyncStatus.PENDING) {
        return {
          event_id: e.event_id,
          status: 'pending',
          server_sequence: null,
          created_at_server: null,
          reason: 'Dependencia de saldo pendiente: ' + id,
        };
      }
      if (dep.syncStatus !== EventSyncStatus.SYNCED) {
        return this.saveConflict(
          manager,
          e,
          'Dependencia de saldo con incidencia: ' + id,
          e.aggregate_id,
        );
      }
    }
    return null;
  }

  private async saveConflict(
    manager: EntityManager,
    e: PushEventDto,
    reason: string,
    winnerId: string,
  ): Promise<PushEventResultDto> {
    const saved = await this.saveEvent(
      manager,
      e,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveRefs(manager, saved);
    const conflict = await this.conflicts.recordConflict(manager, {
      conflictType: 'bank_balance_baseline_exists',
      refType: SaldoCuentaInicialDeclaradoPayload.aggregateType,
      refId: winnerId,
      reason,
      losingEvent: saved,
      defaultWinnerEventId: null,
    });
    return { ...this.result(saved, 'conflict'), conflict_id: conflict.conflictId };
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

  private async saveRefs(manager: EntityManager, e: EventEntity): Promise<void> {
    await manager.insert(
      EventRefEntity,
      [
        {
          refType: SaldoCuentaInicialDeclaradoPayload.aggregateType,
          refId: e.aggregateId,
          relationship: 'affects',
        },
        {
          refType: SaldoCuentaInicialDeclaradoPayload.slotRefType,
          refId: SaldoCuentaInicialDeclaradoPayload.slotRefId,
          relationship: 'requires_unique',
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

  private rejected(e: PushEventDto, reason: string): PushEventResultDto {
    return {
      event_id: e.event_id,
      status: 'rejected',
      server_sequence: null,
      created_at_server: null,
      reason,
    };
  }
}
