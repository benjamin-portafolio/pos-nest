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
import { MAX_SAFE_ATOMIC_QUANTITY } from './payloads/inventory-movement.payload';
import { MovimientoInventarioRegistradoPayload } from './payloads/movimiento-inventario-registrado.payload';
import { RecursoInventarioActualizadoPayload } from './payloads/recurso-inventario-actualizado.payload';
import { RecursoInventarioCreadoPayload } from './payloads/recurso-inventario-creado.payload';
import { SyncConflictService } from './sync-conflict.service';

type InventoryPayload =
  | RecursoInventarioCreadoPayload
  | RecursoInventarioActualizadoPayload
  | MovimientoInventarioRegistradoPayload;

@Injectable()
export class InventoryEventHandler {
  constructor(private readonly syncConflictService: SyncConflictService) {}

  supports(eventType: string): boolean {
    return (
      eventType === RecursoInventarioCreadoPayload.eventType ||
      eventType === RecursoInventarioActualizadoPayload.eventType ||
      eventType === MovimientoInventarioRegistradoPayload.eventType
    );
  }

  async apply(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const identityError = this.validateIdentity(event);
    if (identityError)
      return this.rejectedResult(event.event_id, identityError);

    switch (event.event_type) {
      case RecursoInventarioCreadoPayload.eventType:
        return this.applyCreation(manager, event);
      case RecursoInventarioActualizadoPayload.eventType:
        return this.applyUpdate(manager, event);
      case MovimientoInventarioRegistradoPayload.eventType:
        return this.applyMovement(manager, event);
      default:
        return this.rejectedResult(
          event.event_id,
          `Evento de inventario no soportado: ${event.event_type}`,
        );
    }
  }

  private async applyCreation(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const parsed = this.parsePayload(event);
    if ('error' in parsed) {
      return this.saveRejectedEvent(manager, event, parsed.error);
    }
    const payload = parsed.payload as RecursoInventarioCreadoPayload;
    const envelopeError = this.validateCreationEnvelope(event, payload);
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
        'aggregate_id_conflict',
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
        'movement_id_conflict',
      );
    }

    const canonicalEvent = { ...event, payload: payload.toJson() };
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
        quantityOnHandAtomic: movement
          ? String(movement.quantityDeltaAtomic)
          : '0',
        quantityAvailableAtomic: movement
          ? String(movement.quantityDeltaAtomic)
          : '0',
        version: 1,
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
          reversalOfMovementId: movement.reversalOfMovementId,
          movementType: movement.movementType,
          quantityDeltaAtomic: String(movement.quantityDeltaAtomic),
          totalCostMinor: null,
          reason: movement.reason,
          createdAtLocal: new Date(event.created_at_local),
          serverSequence: savedEvent.serverSequence,
        }),
      );
    }
    return this.toResult(savedEvent, 'accepted');
  }

  private async applyUpdate(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const parsed = this.parsePayload(event);
    if ('error' in parsed) {
      return this.saveRejectedEvent(manager, event, parsed.error);
    }
    const payload = parsed.payload as RecursoInventarioActualizadoPayload;
    const envelopeError = this.validateMutableEnvelope(event);
    if (envelopeError) {
      return this.saveRejectedEvent(manager, event, envelopeError);
    }

    const item = await manager.findOne(InventoryItemEntity, {
      where: { id: event.aggregate_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!item) {
      return this.saveConflict(
        manager,
        event,
        payload,
        'No existe el recurso de inventario que se intenta actualizar.',
        'inventory_item',
        event.aggregate_id,
        null,
        'missing_aggregate',
      );
    }
    const baseError = this.validateBase(event, payload.baseEventId, item);
    if (baseError || item.name !== payload.previousName) {
      return this.saveConflict(
        manager,
        event,
        payload,
        baseError ?? 'El nombre cambió desde la base de la edición.',
        'inventory_item',
        item.id,
        item.lastEventId ?? item.createdEventId,
        'concurrent_inventory_item_update',
      );
    }

    const canonicalEvent = { ...event, payload: payload.toJson() };
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
    item.name = payload.nextName;
    item.version += 1;
    item.lastEventId = event.event_id;
    item.lastServerSequence = savedEvent.serverSequence;
    await manager.save(item);
    return this.toResult(savedEvent, 'accepted');
  }

  private async applyMovement(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const parsed = this.parsePayload(event);
    if ('error' in parsed) {
      return this.saveRejectedEvent(manager, event, parsed.error);
    }
    const payload = parsed.payload as MovimientoInventarioRegistradoPayload;
    const envelopeError = this.validateMutableEnvelope(event);
    if (envelopeError) {
      return this.saveRejectedEvent(manager, event, envelopeError);
    }
    if (payload.movement.movementType === 'initial_balance') {
      return this.saveRejectedEvent(
        manager,
        event,
        'initial_balance solo puede formar parte de recurso_inventario_creado.',
      );
    }

    const item = await manager.findOne(InventoryItemEntity, {
      where: { id: event.aggregate_id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!item) {
      return this.saveConflict(
        manager,
        event,
        payload,
        'No existe el recurso del movimiento.',
        'inventory_item',
        event.aggregate_id,
        null,
        'missing_aggregate',
      );
    }
    const baseError = this.validateBase(event, payload.baseEventId, item);
    if (baseError) {
      return this.saveConflict(
        manager,
        event,
        payload,
        baseError,
        'inventory_item',
        item.id,
        item.lastEventId ?? item.createdEventId,
        'concurrent_inventory_movement',
      );
    }

    const existingMovement = await manager.findOne(InventoryMovementEntity, {
      where: { movementId: payload.movement.movementId },
      lock: { mode: 'pessimistic_write' },
    });
    if (existingMovement) {
      return this.saveConflict(
        manager,
        event,
        payload,
        `Ya existe un movimiento con id ${payload.movement.movementId}.`,
        'inventory_movement',
        payload.movement.movementId,
        existingMovement.eventId,
        'movement_id_conflict',
      );
    }

    if (payload.movement.reversalOfMovementId) {
      const reversed = await manager.findOne(InventoryMovementEntity, {
        where: { movementId: payload.movement.reversalOfMovementId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!reversed || reversed.inventoryItemId !== item.id) {
        return this.saveRejectedEvent(
          manager,
          event,
          'reversal_of_movement_id debe pertenecer al mismo recurso.',
        );
      }
    }

    const balance = await manager.findOne(InventoryBalanceEntity, {
      where: { inventoryItemId: item.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!balance) {
      return this.saveConflict(
        manager,
        event,
        payload,
        'El recurso no tiene un saldo materializado.',
        'inventory_item',
        item.id,
        item.lastEventId ?? item.createdEventId,
        'missing_inventory_balance',
      );
    }
    const onHand = this.safeAdd(
      balance.quantityOnHandAtomic,
      payload.movement.quantityDeltaAtomic,
    );
    const available = this.safeAdd(
      balance.quantityAvailableAtomic,
      payload.movement.quantityDeltaAtomic,
    );
    if ('error' in onHand || 'error' in available) {
      return this.saveRejectedEvent(
        manager,
        event,
        'El saldo de inventario se desbordaría.',
      );
    }

    const canonicalEvent = { ...event, payload: payload.toJson() };
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
        reversalOfMovementId: payload.movement.reversalOfMovementId,
        movementType: payload.movement.movementType,
        quantityDeltaAtomic: String(payload.movement.quantityDeltaAtomic),
        totalCostMinor: null,
        reason: payload.movement.reason,
        createdAtLocal: new Date(event.created_at_local),
        serverSequence: savedEvent.serverSequence,
      }),
    );
    balance.quantityOnHandAtomic = onHand.value;
    balance.quantityAvailableAtomic = available.value;
    balance.version += 1;
    balance.lastEventId = event.event_id;
    balance.lastServerSequence = savedEvent.serverSequence;
    item.version += 1;
    item.lastEventId = event.event_id;
    item.lastServerSequence = savedEvent.serverSequence;
    await manager.save([balance, item]);
    return this.toResult(savedEvent, 'accepted');
  }

  async saveUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const parsed = this.parsePayload(event);
    if ('error' in parsed) {
      return this.saveRejectedEvent(manager, event, parsed.error);
    }
    const movementId =
      parsed.payload instanceof RecursoInventarioCreadoPayload
        ? parsed.payload.initialMovement?.movementId
        : parsed.payload instanceof MovimientoInventarioRegistradoPayload
          ? parsed.payload.movement.movementId
          : null;
    const existingMovement = movementId
      ? await manager.findOneBy(InventoryMovementEntity, { movementId })
      : null;
    const existingItem = await manager.findOneBy(InventoryItemEntity, {
      id: event.aggregate_id,
    });
    return this.saveConflict(
      manager,
      event,
      parsed.payload,
      'El evento chocó con una restricción única del servidor.',
      existingMovement ? 'inventory_movement' : 'inventory_item',
      existingMovement?.movementId ?? event.aggregate_id,
      existingMovement?.eventId ?? existingItem?.lastEventId ?? null,
      existingMovement ? 'movement_id_conflict' : 'aggregate_id_conflict',
    );
  }

  private parsePayload(
    event: PushEventDto,
  ): { payload: InventoryPayload } | { error: string } {
    try {
      switch (event.event_type) {
        case RecursoInventarioCreadoPayload.eventType:
          return {
            payload: RecursoInventarioCreadoPayload.fromJson(event.payload),
          };
        case RecursoInventarioActualizadoPayload.eventType:
          return {
            payload: RecursoInventarioActualizadoPayload.fromJson(
              event.payload,
            ),
          };
        case MovimientoInventarioRegistradoPayload.eventType:
          return {
            payload: MovimientoInventarioRegistradoPayload.fromJson(
              event.payload,
            ),
          };
        default:
          return {
            error: `Evento de inventario no soportado: ${event.event_type}`,
          };
      }
    } catch (error) {
      return { error: this.errorMessage(error) };
    }
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

  private validateCreationEnvelope(
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

  private validateMutableEnvelope(event: PushEventDto): string | null {
    if (event.aggregate_type !== RecursoInventarioCreadoPayload.aggregateType) {
      return `${event.event_type} debe usar aggregate_type inventory_item.`;
    }
    if (
      !Number.isSafeInteger(event.base_version) ||
      Number(event.base_version) < 1
    ) {
      return `${event.event_type} requiere base_version entero >= 1.`;
    }
    const baseSequence = this.toNullableNumber(event.base_server_sequence);
    if (
      event.base_server_sequence !== null &&
      event.base_server_sequence !== undefined &&
      (baseSequence === null || baseSequence < 0)
    ) {
      return 'base_server_sequence debe ser un entero >= 0 o null.';
    }
    return null;
  }

  private validateBase(
    event: PushEventDto,
    baseEventId: string,
    item: InventoryItemEntity,
  ): string | null {
    if (event.base_version !== item.version) {
      return 'La versión base no coincide con el recurso actual.';
    }
    if (baseEventId !== (item.lastEventId ?? item.createdEventId)) {
      return 'base_event_id no coincide con el recurso actual.';
    }
    const baseSequence = this.toNullableNumber(event.base_server_sequence);
    if (
      baseSequence !== null &&
      (item.lastServerSequence === null ||
        baseSequence !== Number(item.lastServerSequence))
    ) {
      return 'base_server_sequence no coincide con el recurso actual.';
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

  private safeAdd(
    current: string,
    delta: number,
  ): { value: string } | { error: true } {
    const result = BigInt(current) + BigInt(delta);
    const max = BigInt(MAX_SAFE_ATOMIC_QUANTITY);
    if (result > max || result < -max) return { error: true };
    return { value: result.toString() };
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
    payload: InventoryPayload,
    reason: string,
    refType: string,
    refId: string,
    defaultWinnerEventId: string | null,
    conflictType: string,
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
    payload: InventoryPayload,
    serverSequence: string,
  ): Promise<void> {
    const refs = [
      {
        refType: 'inventory_item',
        refId: event.aggregate_id,
        relationship: 'affects',
      },
    ];
    if (payload instanceof RecursoInventarioCreadoPayload) {
      refs.push({
        refType: 'unit',
        refId: payload.defaultUnitId,
        relationship: 'uses',
      });
      if (payload.initialMovement) {
        refs.push({
          refType: 'inventory_movement',
          refId: payload.initialMovement.movementId,
          relationship: 'affects',
        });
      }
    } else if (payload instanceof MovimientoInventarioRegistradoPayload) {
      refs.push({
        refType: 'inventory_movement',
        refId: payload.movement.movementId,
        relationship: 'affects',
      });
    }
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

  private toNullableNumber(
    value: string | number | null | undefined,
  ): number | null {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error
      ? error.message
      : 'payload de evento de inventario inválido.';
  }
}
