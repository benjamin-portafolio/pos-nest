import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { ClienteEntity } from '../entities/cliente.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { CustomerPaymentEntity } from '../entities/customer-payment.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { AbonoClienteRegistradoPayload } from './payloads/abono-cliente-registrado.payload';
import { requiredUuidV4 } from './payloads/inventory-movement.payload';
import { CustomerCreditProjector } from './customer-credit.projector';
import { SyncConflictService } from './sync-conflict.service';

@Injectable()
export class AbonoClienteEventHandler {
  constructor(
    private readonly credits: CustomerCreditProjector,
    private readonly conflicts: SyncConflictService,
  ) {}
  supports(type: string): boolean {
    return type === AbonoClienteRegistradoPayload.eventType;
  }
  async apply(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    let p: AbonoClienteRegistradoPayload;
    try {
      requiredUuidV4(e.event_id, 'event_id');
      requiredUuidV4(e.aggregate_id, 'abono_id');
      if (
        e.aggregate_type !== AbonoClienteRegistradoPayload.aggregateType ||
        e.base_version !== 1 ||
        e.base_server_sequence != null
      ) {
        throw new Error('Sobre de abono inválido.');
      }
      p = AbonoClienteRegistradoPayload.fromJson(e.payload);
    } catch (error) {
      return {
        event_id: e.event_id,
        status: 'rejected',
        server_sequence: null,
        created_at_server: null,
        reason: (error as Error).message,
      };
    }
    await this.credits.lock(manager, p.clienteId);
    const duplicate = await manager.findOneBy(EventEntity, {
      eventId: e.event_id,
    });
    if (duplicate) return this.result(duplicate, 'duplicate');
    if (await manager.existsBy(CustomerPaymentEntity, { id: e.aggregate_id })) {
      return this.saveUniqueViolationConflict(manager, e);
    }
    const cliente = await manager.findOneBy(ClienteEntity, { id: p.clienteId });
    const dependency = await manager.findOneBy(EventEntity, {
      eventId: p.clienteEventId,
    });
    if (
      !cliente ||
      cliente.createdEventId !== p.clienteEventId ||
      dependency?.syncStatus !== EventSyncStatus.SYNCED
    ) {
      return this.saveConflict(
        manager,
        e,
        'El cliente del abono no está disponible en el servidor.',
      );
    }
    const saved = await this.saveEvent(
      manager,
      { ...e, payload: p.toJson() },
      EventSyncStatus.SYNCED,
    );
    await manager.insert(CustomerPaymentEntity, {
      id: e.aggregate_id,
      clienteId: p.clienteId,
      amountMinor: String(p.amountMinor),
      method: p.method,
      reference: p.reference,
      occurredAtMs: String(p.occurredAtMs),
      active: true,
      version: 1,
      createdEventId: e.event_id,
      lastEventId: e.event_id,
      lastServerSequence: saved.serverSequence,
    });
    await this.credits.rebuild(manager, p.clienteId);
    await this.saveRefs(manager, saved, p);
    return this.result(saved, 'accepted');
  }
  async saveUniqueViolationConflict(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    return this.saveConflict(manager, e, 'Identidad de abono ya registrada.');
  }
  private async saveConflict(
    manager: EntityManager,
    e: PushEventDto,
    reason: string,
  ): Promise<PushEventResultDto> {
    const p = AbonoClienteRegistradoPayload.fromJson(e.payload);
    const saved = await this.saveEvent(
      manager,
      e,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveRefs(manager, saved, p);
    const conflict = await this.conflicts.recordConflict(manager, {
      conflictType: 'customer_payment_integrity',
      refType: 'customer_account',
      refId: p.clienteId,
      reason,
      losingEvent: saved,
      defaultWinnerEventId: null,
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
    p: AbonoClienteRegistradoPayload,
  ): Promise<void> {
    await manager.insert(
      EventRefEntity,
      [
        {
          refType: AbonoClienteRegistradoPayload.aggregateType,
          refId: e.aggregateId,
          relationship: 'affects',
        },
        {
          refType: 'customer_account',
          refId: p.clienteId,
          relationship: 'affects',
        },
        { refType: 'cliente', refId: p.clienteId, relationship: 'uses' },
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
