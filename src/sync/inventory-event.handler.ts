import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { UnitEntity } from '../entities/unit.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import type { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { ExistenciaInventarioAjustadaPayload } from './payloads/existencia-inventario-ajustada.payload';
import { RecursoInventarioCreadoPayload } from './payloads/recurso-inventario-creado.payload';
import { SyncConflictService } from './sync-conflict.service';

type InventoryEventPayload =
  | RecursoInventarioCreadoPayload
  | ExistenciaInventarioAjustadaPayload;

@Injectable()
export class InventoryEventHandler {
  constructor(private readonly syncConflictService: SyncConflictService) {}

  supports(eventType: string): boolean {
    return (
      eventType === RecursoInventarioCreadoPayload.eventType ||
      eventType === ExistenciaInventarioAjustadaPayload.eventType
    );
  }

  async apply(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const identityError = this.validateIdentity(event);
    if (identityError)
      return this.rejectedResult(event.event_id, identityError);

    if (event.event_type === RecursoInventarioCreadoPayload.eventType) {
      return this.applyCreation(manager, event);
    }
    if (event.event_type === ExistenciaInventarioAjustadaPayload.eventType) {
      return this.applyAdjustment(manager, event);
    }
    return this.rejectedResult(
      event.event_id,
      `Evento de inventario no soportado: ${event.event_type}`,
    );
  }

  private async applyCreation(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    let payload: RecursoInventarioCreadoPayload;
    try {
      payload = RecursoInventarioCreadoPayload.fromJson(event.payload);
    } catch (error) {
      return this.saveRejectedEvent(manager, event, this.errorMessage(error));
    }

    const envelopeError = this.validateEnvelope(event, payload);
    if (envelopeError) {
      return this.saveRejectedEvent(manager, event, envelopeError);
    }

    const unit = await manager.findOne(UnitEntity, {
      where: { unitId: payload.defaultUnitId },
      lock: { mode: 'pessimistic_read' },
    });
    const unitError = this.validateUnit(unit);
    if (unitError) return this.saveRejectedEvent(manager, event, unitError);

    const existingItem = await manager.findOne(InventoryItemEntity, {
      where: { id: event.aggregate_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (existingItem && existingItem.createdEventId !== event.event_id) {
      return this.saveConflict(
        manager,
        event,
        payload,
        `Ya existe un recurso de inventario con id ${event.aggregate_id}.`,
        'inventory_item',
        event.aggregate_id,
        existingItem.createdEventId,
      );
    }

    const movement = payload.initialMovement;
    const existingMovement = movement
      ? await manager.findOne(InventoryMovementEntity, {
          where: { movementId: movement.movementId },
          lock: { mode: 'pessimistic_write' },
        })
      : null;
    if (existingMovement && existingMovement.eventId !== event.event_id) {
      return this.saveConflict(
        manager,
        event,
        payload,
        `Ya existe un movimiento con id ${movement!.movementId}.`,
        'inventory_movement',
        movement!.movementId,
        existingMovement.eventId,
      );
    }

    const canonicalEvent: PushEventDto = {
      ...event,
      payload: payload.toJson(),
    };
    const savedEvent = await this.saveEvent(
      manager,
      canonicalEvent,
      EventSyncStatus.SYNCED,
    );
    await this.saveEventRefs(
      manager,
      canonicalEvent,
      payload,
      savedEvent.serverSequence,
    );

    if (existingItem) {
      existingItem.lastServerSequence = savedEvent.serverSequence;
      await manager.save(existingItem);
      await manager.update(
        InventoryBalanceEntity,
        { inventoryItemId: existingItem.id, lastEventId: event.event_id },
        { lastServerSequence: savedEvent.serverSequence },
      );
      if (existingMovement) {
        existingMovement.serverSequence = savedEvent.serverSequence;
        await manager.save(existingMovement);
      }
      return this.toResult(savedEvent, 'accepted');
    }

    const item = await manager.save(
      manager.create(InventoryItemEntity, {
        id: event.aggregate_id,
        defaultUnitId: payload.defaultUnitId,
        name: payload.name,
        active: true,
        version: 1,
        createdEventId: event.event_id,
        lastEventId: event.event_id,
        lastServerSequence: savedEvent.serverSequence,
      }),
    );
    await manager.save(
      manager.create(InventoryBalanceEntity, {
        inventoryItemId: item.id,
        quantityOnHandAtomic: '0',
        quantityAvailableAtomic: '0',
        lastEventId: event.event_id,
        lastServerSequence: savedEvent.serverSequence,
      }),
    );

    if (movement) {
      await manager.save(
        manager.create(InventoryMovementEntity, {
          movementId: movement.movementId,
          inventoryItemId: item.id,
          saleItemId: null,
          eventId: event.event_id,
          reversalOfMovementId: null,
          movementType: movement.movementType,
          quantityDeltaAtomic: String(movement.quantityDeltaAtomic),
          totalCostMinor: null,
          reason: movement.reason,
          createdAtLocal: new Date(event.created_at_local),
          serverSequence: savedEvent.serverSequence,
        }),
      );
      const lockedBalance = await manager.findOneOrFail(
        InventoryBalanceEntity,
        {
          where: { inventoryItemId: item.id },
          lock: { mode: 'pessimistic_write' },
        },
      );
      const updated = (
        BigInt(lockedBalance.quantityOnHandAtomic) +
        BigInt(movement.quantityDeltaAtomic)
      ).toString();
      lockedBalance.quantityOnHandAtomic = updated;
      lockedBalance.quantityAvailableAtomic = updated;
      lockedBalance.lastEventId = event.event_id;
      lockedBalance.lastServerSequence = savedEvent.serverSequence;
      await manager.save(lockedBalance);
    }

    return this.toResult(savedEvent, 'accepted');
  }

  private async applyAdjustment(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    let payload: ExistenciaInventarioAjustadaPayload;
    try {
      payload = ExistenciaInventarioAjustadaPayload.fromJson(event.payload);
    } catch (error) {
      return this.saveRejectedEvent(manager, event, this.errorMessage(error));
    }

    const envelopeError = this.validateAdjustmentEnvelope(event, payload);
    if (envelopeError) {
      return this.saveRejectedEvent(manager, event, envelopeError);
    }

    const item = await manager.findOne(InventoryItemEntity, {
      where: { id: event.aggregate_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!item || !item.active) {
      return this.saveConflict(
        manager,
        event,
        payload,
        item
          ? `El recurso de inventario ${event.aggregate_id} está inactivo.`
          : `No existe el recurso de inventario ${event.aggregate_id}.`,
        'inventory_item',
        event.aggregate_id,
        item?.lastEventId ?? item?.createdEventId ?? null,
        'missing_inventory_item',
      );
    }
    if (event.base_version! > item.version) {
      return this.saveRejectedEvent(
        manager,
        event,
        'base_version del ajuste está adelantada respecto al recurso oficial.',
      );
    }

    const movement = await manager.findOne(InventoryMovementEntity, {
      where: { movementId: payload.movement.movementId },
      lock: { mode: 'pessimistic_write' },
    });
    if (movement && movement.eventId !== event.event_id) {
      return this.saveConflict(
        manager,
        event,
        payload,
        `Ya existe un movimiento con id ${payload.movement.movementId}.`,
        'inventory_movement',
        payload.movement.movementId,
        movement.eventId,
        'inventory_movement_conflict',
      );
    }
    if (movement) {
      const existingEvent = await manager.findOneBy(EventEntity, {
        eventId: event.event_id,
      });
      if (existingEvent) return this.toResult(existingEvent, 'accepted');
      return this.rejectedResult(
        event.event_id,
        `El movimiento ${movement.movementId} ya fue aplicado sin su evento.`,
      );
    }

    const balance = await manager.findOne(InventoryBalanceEntity, {
      where: { inventoryItemId: item.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!balance) {
      return this.saveRejectedEvent(
        manager,
        event,
        `El recurso de inventario ${item.id} no tiene balance.`,
      );
    }

    let quantityOnHandAtomic: string;
    let quantityAvailableAtomic: string;
    try {
      quantityOnHandAtomic = this.safeAtomicSum(
        balance.quantityOnHandAtomic,
        payload.movement.quantityDeltaAtomic,
      );
      quantityAvailableAtomic = this.safeAtomicSum(
        balance.quantityAvailableAtomic,
        payload.movement.quantityDeltaAtomic,
      );
    } catch (error) {
      return this.saveRejectedEvent(manager, event, this.errorMessage(error));
    }

    const canonicalEvent: PushEventDto = {
      ...event,
      payload: payload.toJson(),
    };
    const savedEvent = await this.saveEvent(
      manager,
      canonicalEvent,
      EventSyncStatus.SYNCED,
    );
    await this.saveEventRefs(
      manager,
      canonicalEvent,
      payload,
      savedEvent.serverSequence,
    );

    await manager.save(
      manager.create(InventoryMovementEntity, {
        movementId: payload.movement.movementId,
        inventoryItemId: item.id,
        saleItemId: null,
        eventId: event.event_id,
        reversalOfMovementId: null,
        movementType: payload.movement.movementType,
        quantityDeltaAtomic: String(payload.movement.quantityDeltaAtomic),
        totalCostMinor: null,
        reason: payload.movement.reason,
        createdAtLocal: new Date(event.created_at_local),
        serverSequence: savedEvent.serverSequence,
      }),
    );

    balance.quantityOnHandAtomic = quantityOnHandAtomic;
    balance.quantityAvailableAtomic = quantityAvailableAtomic;
    balance.lastEventId = event.event_id;
    balance.lastServerSequence = savedEvent.serverSequence;
    await manager.save(balance);

    item.version += 1;
    item.lastEventId = event.event_id;
    item.lastServerSequence = savedEvent.serverSequence;
    await manager.save(item);

    return this.toResult(savedEvent, 'accepted');
  }

  async saveUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    if (event.event_type === ExistenciaInventarioAjustadaPayload.eventType) {
      return this.saveAdjustmentUniqueViolationConflict(manager, event);
    }

    let payload: RecursoInventarioCreadoPayload;
    try {
      payload = RecursoInventarioCreadoPayload.fromJson(event.payload);
    } catch (error) {
      return this.saveRejectedEvent(manager, event, this.errorMessage(error));
    }
    const existingItem = await manager.findOneBy(InventoryItemEntity, {
      id: event.aggregate_id,
    });
    if (existingItem) {
      return this.saveConflict(
        manager,
        event,
        payload,
        `Ya existe un recurso de inventario con id ${event.aggregate_id}.`,
        'inventory_item',
        event.aggregate_id,
        existingItem.createdEventId,
      );
    }
    const movementId = payload.initialMovement?.movementId;
    const existingMovement = movementId
      ? await manager.findOneBy(InventoryMovementEntity, { movementId })
      : null;
    return this.saveConflict(
      manager,
      event,
      payload,
      'El evento chocó con una restricción única del servidor.',
      movementId ? 'inventory_movement' : 'inventory_item',
      movementId ?? event.aggregate_id,
      existingMovement?.eventId ?? null,
    );
  }

  private async saveAdjustmentUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    let payload: ExistenciaInventarioAjustadaPayload;
    try {
      payload = ExistenciaInventarioAjustadaPayload.fromJson(event.payload);
    } catch (error) {
      return this.saveRejectedEvent(manager, event, this.errorMessage(error));
    }
    const existingMovement = await manager.findOneBy(InventoryMovementEntity, {
      movementId: payload.movement.movementId,
    });
    const item = await manager.findOneBy(InventoryItemEntity, {
      id: event.aggregate_id,
    });
    return this.saveConflict(
      manager,
      event,
      payload,
      existingMovement
        ? `Ya existe un movimiento con id ${payload.movement.movementId}.`
        : 'El ajuste chocó con una restricción única del servidor.',
      existingMovement ? 'inventory_movement' : 'inventory_item',
      existingMovement?.movementId ?? event.aggregate_id,
      existingMovement?.eventId ?? item?.lastEventId ?? null,
      existingMovement
        ? 'inventory_movement_conflict'
        : 'inventory_adjustment_conflict',
    );
  }

  private validateIdentity(event: PushEventDto): string | null {
    if (!this.isUuidV4(event.event_id)) {
      return `event_id de ${event.event_type} debe ser un UUID v4.`;
    }
    if (!this.isUuidV4(event.aggregate_id)) {
      return `aggregate_id de ${event.event_type} debe ser un UUID v4.`;
    }
    return null;
  }

  private validateAdjustmentEnvelope(
    event: PushEventDto,
    payload: ExistenciaInventarioAjustadaPayload,
  ): string | null {
    if (
      event.aggregate_type !== ExistenciaInventarioAjustadaPayload.aggregateType
    ) {
      return 'existencia_inventario_ajustada debe usar aggregate_type inventory_item.';
    }
    if (event.aggregate_id !== payload.inventoryItemId) {
      return 'inventory_item_id debe coincidir con aggregate_id.';
    }
    if (
      !Number.isSafeInteger(event.base_version) ||
      (event.base_version ?? 0) < 1
    ) {
      return 'existencia_inventario_ajustada requiere base_version positiva.';
    }
    return null;
  }

  private validateEnvelope(
    event: PushEventDto,
    payload: RecursoInventarioCreadoPayload,
  ): string | null {
    if (event.aggregate_type !== RecursoInventarioCreadoPayload.aggregateType) {
      return 'recurso_inventario_creado debe usar aggregate_type inventory_item.';
    }
    if (event.aggregate_id !== payload.inventoryItemId) {
      return 'inventory_item.inventory_item_id debe coincidir con aggregate_id.';
    }
    if (event.base_version !== 1) {
      return 'recurso_inventario_creado requiere base_version = 1.';
    }
    if (
      event.base_server_sequence !== null &&
      event.base_server_sequence !== undefined
    ) {
      return 'recurso_inventario_creado requiere base_server_sequence = null.';
    }
    return null;
  }

  private validateUnit(unit: UnitEntity | null): string | null {
    if (!unit) return 'La unidad predeterminada no existe.';
    if (!unit.active) return 'La unidad predeterminada está inactiva.';
    const factor = Number(unit.atomicFactor);
    if (
      !['count', 'mass', 'volume'].includes(unit.dimension) ||
      !Number.isSafeInteger(factor) ||
      factor <= 0 ||
      !Number.isSafeInteger(unit.maxFractionDigits) ||
      unit.maxFractionDigits < 0 ||
      unit.maxFractionDigits > 9
    ) {
      return 'La configuración de la unidad predeterminada es inválida.';
    }
    return null;
  }

  private async saveRejectedEvent(
    manager: EntityManager,
    event: PushEventDto,
    reason: string,
  ): Promise<PushEventResultDto> {
    const saved = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.REJECTED,
      reason,
    );
    return this.toResult(saved, 'rejected', reason);
  }

  private async saveConflict(
    manager: EntityManager,
    event: PushEventDto,
    payload: InventoryEventPayload,
    reason: string,
    refType: string,
    refId: string,
    defaultWinnerEventId: string | null,
    conflictType = 'aggregate_id_conflict',
  ): Promise<PushEventResultDto> {
    const canonicalEvent = { ...event, payload: payload.toJson() };
    const saved = await this.saveEvent(
      manager,
      canonicalEvent,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveEventRefs(
      manager,
      canonicalEvent,
      payload,
      saved.serverSequence,
    );
    const conflict = await this.syncConflictService.recordConflict(manager, {
      conflictType,
      refType,
      refId,
      reason,
      losingEvent: saved,
      defaultWinnerEventId,
    });
    return this.toResult(saved, 'conflict', reason, conflict.conflictId);
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
        baseServerSequence:
          event.base_server_sequence === null ||
          event.base_server_sequence === undefined
            ? null
            : String(event.base_server_sequence),
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
    payload: InventoryEventPayload,
    serverSequence: string,
  ): Promise<void> {
    const refs =
      payload instanceof RecursoInventarioCreadoPayload
        ? [
            {
              refType: 'inventory_item',
              refId: event.aggregate_id,
              relationship: 'affects',
            },
            {
              refType: 'unit',
              refId: payload.defaultUnitId,
              relationship: 'uses',
            },
            ...(payload.initialMovement
              ? [
                  {
                    refType: 'inventory_movement',
                    refId: payload.initialMovement.movementId,
                    relationship: 'affects',
                  },
                ]
              : []),
          ]
        : [
            {
              refType: 'inventory_item',
              refId: event.aggregate_id,
              relationship: 'affects',
            },
            {
              refType: 'inventory_movement',
              refId: payload.movement.movementId,
              relationship: 'affects',
            },
          ];
    await manager.save(
      refs.map((ref) =>
        manager.create(EventRefEntity, {
          eventRefId: randomUUID(),
          eventId: event.event_id,
          ...ref,
          serverSequence,
          source: 'server',
        }),
      ),
    );
  }

  private toResult(
    event: EventEntity,
    status: PushEventResultDto['status'],
    reason?: string,
    conflictId?: string,
  ): PushEventResultDto {
    return {
      event_id: event.eventId,
      status,
      server_sequence: Number(event.serverSequence),
      created_at_server: event.createdAtServer.toISOString(),
      ...(reason ? { reason } : {}),
      ...(conflictId ? { conflict_id: conflictId } : {}),
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

  private isUuidV4(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'payload de evento de inventario inválido.';
  }

  private safeAtomicSum(current: string, delta: number): string {
    const result = BigInt(current) + BigInt(delta);
    const limit = BigInt(Number.MAX_SAFE_INTEGER);
    if (result > limit || result < -limit) {
      throw new Error('El saldo excede el límite entero seguro.');
    }
    return result.toString();
  }
}
