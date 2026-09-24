import { ClienteEntity } from '../entities/cliente.entity';
import { CreditSaleEntity } from '../entities/credit-sale.entity';
import { CustomerCreditProjector } from './customer-credit.projector';
import { SaleMode } from '../enums/sale-mode.enum';
import { ProductEntity } from '../entities/product.entity';
import { UnitEntity } from '../entities/unit.entity';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { isDeepStrictEqual } from 'util';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { SaleEntity } from '../entities/sale.entity';
import { SaleItemEntity } from '../entities/sale-item.entity';
import { SalePaymentEntity } from '../entities/sale-payment.entity';
import { ProductVariantEntity } from '../entities/product-variant.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { ProductoCreadoPayload } from './payloads/producto-creado.payload';
import { ProductoActualizadoPayload } from './payloads/producto-actualizado.payload';
import {
  VentaConfirmadaPayload,
  ConfirmedSaleLine,
  lineTotal,
} from './payloads/venta-confirmada.payload';
import { requiredUuidV4 } from './payloads/inventory-movement.payload';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { SyncConflictService } from './sync-conflict.service';

@Injectable()
export class VentaEventHandler {
  constructor(
    private readonly conflicts: SyncConflictService,
    private readonly credits: CustomerCreditProjector = new CustomerCreditProjector(),
  ) {}
  supports(type: string): boolean {
    return type === VentaConfirmadaPayload.eventType;
  }
  async apply(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    try {
      requiredUuidV4(event.event_id, 'event_id');
      requiredUuidV4(event.aggregate_id, 'sale_id');
    } catch (error) {
      return {
        event_id: event.event_id,
        status: 'rejected',
        server_sequence: null,
        created_at_server: null,
        reason: (error as Error).message,
      };
    }
    let p: VentaConfirmadaPayload;
    try {
      if (
        event.aggregate_type !== VentaConfirmadaPayload.aggregateType ||
        event.base_version !== 1 ||
        event.base_server_sequence != null
      )
        throw new Error(
          'La venta requiere base_version 1 y ninguna base oficial.',
        );
      p = VentaConfirmadaPayload.fromJson(event.payload);
    } catch (e) {
      return this.saveOutcome(manager, event, 'rejected', (e as Error).message);
    }
    if (p.clienteId) await this.credits.lock(manager, p.clienteId);
    // Serializa confirmaciones del mismo sale_id incluso cuando aún no existe.
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['sale:' + event.aggregate_id],
    );
    const duplicate = await manager.findOneBy(EventEntity, {
      eventId: event.event_id,
    });
    if (duplicate) return this.result(duplicate, 'duplicate');
    if (await manager.existsBy(SaleEntity, { id: event.aggregate_id }))
      return this.saveOutcome(
        manager,
        event,
        'conflict',
        'Esta venta ya fue confirmada.',
      );
    for (const id of p.dependencyEventIds) {
      const dependency = await manager.findOneBy(EventEntity, { eventId: id });
      if (!dependency || dependency.syncStatus !== EventSyncStatus.SYNCED)
        return this.saveOutcome(
          manager,
          event,
          'conflict',
          'Dependencia histórica no disponible: ' + id,
        );
    }
    if (p.clienteId) {
      const cliente = await manager.findOneBy(ClienteEntity, {
        id: p.clienteId,
      });
      if (!cliente || cliente.createdEventId !== p.clienteEventId) {
        return this.saveOutcome(
          manager,
          event,
          'conflict',
          'Falta el cliente histórico de la venta.',
        );
      }
    }
    // Mismo orden de bloqueo que edición de catálogo: producto, variante, recurso, saldo.
    for (const id of [...new Set(p.lines.map((l) => l.product_id))].sort()) {
      await manager.findOne(ProductEntity, {
        where: { id },
        lock: { mode: 'pessimistic_read' },
      });
    }
    for (const id of [
      ...new Set(p.lines.map((l) => l.snapshot.variant_id)),
    ].sort()) {
      await manager.findOne(ProductVariantEntity, {
        where: { id },
        lock: { mode: 'pessimistic_read' },
      });
    }
    // La receta actual y el saldo no son bases optimistas de una venta histórica.
    for (const line of p.lines) {
      const error = await this.validateHistory(manager, line);
      if (error) return this.saveOutcome(manager, event, 'rejected', error);
      const variant = await manager.findOneBy(ProductVariantEntity, {
        id: line.snapshot.variant_id,
      });
      if (!variant || variant.productId !== line.product_id)
        return this.saveOutcome(
          manager,
          event,
          'conflict',
          'Falta la variante histórica.',
        );
    }
    const deltas = new Map<string, bigint>();
    for (const l of p.lines)
      for (const c of l.consumptions)
        deltas.set(
          c.inventory_item_id,
          (deltas.get(c.inventory_item_id) ?? 0n) +
            BigInt(c.quantity_delta_atomic),
        );
    const balances: InventoryBalanceEntity[] = [];
    // Bloquear primero recursos, luego saldos, en el mismo orden que inventario.
    for (const id of [...deltas.keys()].sort()) {
      const item = await manager.findOne(InventoryItemEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!item)
        return this.saveOutcome(
          manager,
          event,
          'conflict',
          'Falta el recurso histórico: ' + id,
        );
    }
    for (const id of [...deltas.keys()].sort()) {
      const b = await manager.findOne(InventoryBalanceEntity, {
        where: { inventoryItemId: id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!b)
        return this.saveOutcome(
          manager,
          event,
          'conflict',
          'Falta el saldo: ' + id,
        );
      const onHand = BigInt(b.quantityOnHandAtomic) + deltas.get(id)!;
      const available = BigInt(b.quantityAvailableAtomic) + deltas.get(id)!;
      const max = BigInt(Number.MAX_SAFE_INTEGER);
      if (onHand > max || onHand < -max || available > max || available < -max)
        return this.saveOutcome(
          manager,
          event,
          'rejected',
          'Saldo fuera de rango.',
        );
      b.quantityOnHandAtomic = String(onHand);
      b.quantityAvailableAtomic = String(available);
      balances.push(b);
    }
    const saved = await this.saveEvent(
      manager,
      { ...event, payload: p.toJson() },
      EventSyncStatus.SYNCED,
    );
    const metadata = {
      active: true,
      version: 1,
      createdEventId: event.event_id,
      lastEventId: event.event_id,
      lastServerSequence: saved.serverSequence,
    };
    await manager.insert(SaleEntity, {
      ...metadata,
      id: event.aggregate_id,
      userId: event.user_id,
      deviceId: event.device_id,
      status: 'confirmada',
      clienteId: p.clienteId,
      totalMinor: String(p.totalMinor),
      currency: 'MXN',
      createdAtLocal: new Date(event.created_at_local),
    });
    for (const [index, l] of p.lines.entries())
      await manager.insert(SaleItemEntity, {
        ...metadata,
        id: l.sale_item_id,
        saleId: event.aggregate_id,
        variantId: l.snapshot.variant_id,
        totalMinor: String(lineTotal(l.snapshot)),
        sortOrder: index,
        snapshot: l,
      });
    if (p.paymentMethod === 'credit') {
      await manager.insert(CreditSaleEntity, {
        ...metadata,
        id: event.aggregate_id,
        saleId: event.aggregate_id,
        clienteId: p.clienteId!,
        amountMinor: String(p.totalMinor),
        occurredAtMs: String(p.occurredAtMs),
      });
      await this.credits.rebuild(manager, p.clienteId!);
    } else {
      await manager.insert(SalePaymentEntity, {
        ...metadata,
        id: p.paymentId!,
        saleId: event.aggregate_id,
        method: p.paymentMethod,
        reference: p.paymentReference,
        currency: 'MXN',
        amountMinor: String(p.totalMinor),
        receivedMinor: String(p.receivedMinor),
        changeMinor: String(p.changeMinor),
      });
    }
    for (const l of p.lines)
      for (const c of l.consumptions) {
        if (c.movement_id === null) continue;
        await manager.insert(InventoryMovementEntity, {
          movementId: c.movement_id,
          inventoryItemId: c.inventory_item_id,
          saleItemId: l.sale_item_id,
          eventId: event.event_id,
          movementType: 'sale_consumption',
          quantityDeltaAtomic: String(c.quantity_delta_atomic),
          totalCostMinor: null,
          reason: null,
          reversalOfMovementId: null,
          createdAtLocal: new Date(event.created_at_local),
          serverSequence: saved.serverSequence,
        });
      }
    for (const b of balances) {
      if (deltas.get(b.inventoryItemId) === 0n) continue;
      b.version++;
      b.lastEventId = event.event_id;
      b.lastServerSequence = saved.serverSequence;
      await manager.save(b);
    }
    await this.saveRefs(manager, saved, p);
    return this.result(saved, 'accepted');
  }
  private async validateHistory(
    manager: EntityManager,
    l: ConfirmedSaleLine,
  ): Promise<string | null> {
    const base = await manager.findOneBy(EventEntity, {
      eventId: l.configuration_event_id,
    });
    if (
      !base ||
      base.aggregateId !== l.product_id ||
      base.syncStatus !== EventSyncStatus.SYNCED
    )
      return 'Configuración histórica inexistente.';
    let state: ProductoCreadoPayload;
    if (base.eventType === ProductoCreadoPayload.eventType)
      state = ProductoCreadoPayload.fromJson(base.payload);
    else if (base.eventType === ProductoActualizadoPayload.eventType) {
      const update = ProductoActualizadoPayload.fromJson(base.payload);
      if (update.deleteProduct)
        return 'No se puede vender desde una configuración desactivada.';
      state = update.after;
    } else return 'Evento de configuración inválido.';
    const v = state.variants.find((v) => v.id === l.snapshot.variant_id);
    if (!v) return 'La configuración no contiene la variante.';
    const mode = v.inventoryItemId
      ? 'direct'
      : v.recipeComponents.length
        ? 'recipe'
        : 'none';
    const expected = v.inventoryItemId
      ? [{ id: v.inventoryItemId, quantity: 1 }]
      : v.recipeComponents.map((c) => ({
          id: c.inventoryItemId,
          quantity: c.quantityAtomic,
        }));
    const actual = l.consumptions.map((c) => ({
      id: c.inventory_item_id,
      quantity: c.component_atomic,
    }));
    const order = (a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id);
    const config = state.saleConfiguration;
    if (
      mode !== l.consumption_mode ||
      !isDeepStrictEqual(expected.sort(order), actual.sort(order)) ||
      String(config.mode) !== l.snapshot.sale_mode_snapshot ||
      (config.mode === SaleMode.MEASURED &&
        (config.saleUnitId !== l.sale_unit_id ||
          config.priceReferenceQuantityAtomic !==
            l.snapshot.price_reference_quantity_atomic_snapshot))
    )
      return 'El consumo no coincide con la configuración histórica.';
    if (l.sale_unit_id) {
      const unit = await manager.findOneBy(UnitEntity, {
        unitId: l.sale_unit_id,
      });
      if (
        !unit ||
        Number(unit.atomicFactor) !==
          l.snapshot.sale_unit_atomic_factor_snapshot ||
        unit.code !== l.snapshot.sale_unit_code_snapshot ||
        unit.symbol !== l.snapshot.sale_unit_symbol_snapshot
      )
        return 'Unidad histórica inconsistente.';
    }
    return null;
  }
  async saveUniqueViolationConflict(
    manager: EntityManager,
    e: PushEventDto,
  ): Promise<PushEventResultDto> {
    return this.saveOutcome(
      manager,
      e,
      'conflict',
      'Identidad de venta, línea, pago o movimiento ya registrada.',
    );
  }
  private async saveOutcome(
    manager: EntityManager,
    e: PushEventDto,
    status: 'conflict' | 'rejected',
    reason: string,
  ): Promise<PushEventResultDto> {
    const saved = await this.saveEvent(
      manager,
      e,
      status === 'conflict'
        ? EventSyncStatus.CONFLICT
        : EventSyncStatus.REJECTED,
      reason,
    );
    if (status === 'conflict') {
      await this.saveRefs(
        manager,
        saved,
        VentaConfirmadaPayload.fromJson(e.payload),
      );
      const conflict = await this.conflicts.recordConflict(manager, {
        conflictType: 'sale_integrity',
        refType: 'sale',
        refId: e.aggregate_id,
        reason,
        losingEvent: saved,
        defaultWinnerEventId: null,
      });
      return {
        ...this.result(saved, status),
        conflict_id: conflict.conflictId,
      };
    }
    return this.result(saved, status);
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
        baseVersion: e.base_version,
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
    p: VentaConfirmadaPayload,
  ): Promise<void> {
    const refs = [
      { refType: 'sale', refId: e.aggregateId, relationship: 'affects' },
      ...(p.paymentId
        ? [{ refType: 'payment', refId: p.paymentId, relationship: 'affects' }]
        : []),
      ...(p.clienteId
        ? [{ refType: 'cliente', refId: p.clienteId, relationship: 'uses' }]
        : []),
      ...(p.paymentMethod === 'credit'
        ? [
            {
              refType: 'credit',
              refId: e.aggregateId,
              relationship: 'affects',
            },
            {
              refType: 'customer_account',
              refId: p.clienteId!,
              relationship: 'affects',
            },
          ]
        : []),
    ];
    for (const l of p.lines) {
      refs.push(
        {
          refType: 'sale_item',
          refId: l.sale_item_id,
          relationship: 'affects',
        },
        { refType: 'product', refId: l.product_id, relationship: 'uses' },
        {
          refType: 'product_variant',
          refId: l.snapshot.variant_id,
          relationship: 'uses',
        },
        {
          refType: 'recipe',
          refId: l.snapshot.variant_id,
          relationship: 'uses',
        },
      );
      if (l.sale_unit_id)
        refs.push({
          refType: 'unit',
          refId: l.sale_unit_id,
          relationship: 'uses',
        });
      for (const c of l.consumptions) {
        refs.push({
          refType: 'inventory_item',
          refId: c.inventory_item_id,
          relationship: 'uses',
        });
        if (c.movement_id)
          refs.push({
            refType: 'inventory_movement',
            refId: c.movement_id,
            relationship: 'affects',
          });
      }
    }
    await manager.insert(
      EventRefEntity,
      refs.map((ref) => ({
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
