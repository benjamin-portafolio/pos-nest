import { SupplierReceiptEffects } from './supplier-receipt-effects';
import { SupplierReceiptConfirmedPayload } from './payloads/supplier-receipt-confirmed-payload';
import { SupplierOrderClosedPayload } from './payloads/supplier-order-closed-payload';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { SupplierOrderEntity } from '../entities/supplier-order.entity';
import { SupplierOrderItemEntity } from '../entities/supplier-order-item.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { SupplierOrderDraftSavedPayload } from './payloads/supplier-order-draft-saved-payload';
import { SupplierOrderConfirmedPayload } from './payloads/supplier-order-confirmed-payload';
import { SupplierOrderCancelledPayload } from './payloads/supplier-order-cancelled-payload';
import { SyncConflictService } from './sync-conflict.service';
import { supplierDuplicateMatches } from './payloads/supplier-event-identity';

@Injectable()
export class SupplierOrderEventHandler {
  constructor(private readonly conflicts: SyncConflictService) {}
  supports(type: string): boolean {
    return [
      SupplierOrderDraftSavedPayload.eventType,
      SupplierOrderConfirmedPayload.eventType,
      SupplierOrderCancelledPayload.eventType,
      SupplierReceiptConfirmedPayload.eventType,
      SupplierOrderClosedPayload.eventType,
    ].includes(type);
  }
  async apply(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    let doc:
      | SupplierOrderDraftSavedPayload
      | SupplierOrderConfirmedPayload
      | undefined;
    let orderId: string, baseEventId: string | null;
    const fulfilment = [
      'supplier_receipt_confirmed',
      'supplier_order_closed',
    ].includes(event.event_type);
    const cancelled =
      event.event_type === SupplierOrderCancelledPayload.eventType;
    const status = cancelled
      ? 'cancelled'
      : event.event_type === SupplierOrderConfirmedPayload.eventType
        ? 'confirmed'
        : 'draft';
    try {
      if (
        event.aggregate_type !== 'supplier_order' ||
        !Number.isSafeInteger(event.base_version) ||
        event.base_version! < 1
      )
        throw new Error('Base de pedido inválida.');
      if (fulfilment) {
        const p =
          event.event_type === SupplierReceiptConfirmedPayload.eventType
            ? SupplierReceiptConfirmedPayload.fromJson(event.payload)
            : SupplierOrderClosedPayload.fromJson(event.payload);
        orderId = p.orderId;
        baseEventId = p.baseEventId;
      } else if (cancelled) {
        const p = SupplierOrderCancelledPayload.fromJson(event.payload);
        orderId = p.orderId;
        baseEventId = p.baseEventId;
      } else {
        doc =
          status === 'confirmed'
            ? SupplierOrderConfirmedPayload.fromJson(event.payload)
            : SupplierOrderDraftSavedPayload.fromJson(event.payload);
        orderId = doc.orderId;
        baseEventId = doc.baseEventId;
      }
      if (
        orderId !== event.aggregate_id ||
        (baseEventId === null &&
          (event.base_version !== 1 || event.base_server_sequence != null))
      )
        throw new Error('Identidad o base inválida.');
    } catch (e) {
      return this.result(
        await this.saveEvent(
          manager,
          event,
          EventSyncStatus.REJECTED,
          (e as Error).message,
        ),
        'rejected',
      );
    }
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['supplier_order:' + orderId],
    );
    const duplicate = await manager.findOneBy(EventEntity, {
      eventId: event.event_id,
    });
    if (duplicate)
      return supplierDuplicateMatches(event, duplicate)
        ? this.result(duplicate, 'duplicate')
        : {
            event_id: event.event_id,
            status: 'rejected',
            server_sequence: null,
            created_at_server: null,
            reason: 'Identidad reutilizada con otra intención.',
          };
    const current = await manager.findOne(SupplierOrderEntity, {
      where: { id: orderId },
      lock: { mode: 'pessimistic_write' },
    });
    const base =
      baseEventId === null
        ? null
        : await manager.findOneBy(EventEntity, { eventId: baseEventId });
    if (
      baseEventId === null
        ? current !== null
        : !current ||
          current.lastEventId !== baseEventId ||
          current.version !== event.base_version ||
          !base ||
          base.syncStatus !== EventSyncStatus.SYNCED ||
          base.aggregateType !== 'supplier_order' ||
          base.aggregateId !== orderId ||
          (event.base_server_sequence != null &&
            Number(event.base_server_sequence) > Number(base.serverSequence))
    ) {
      return this.saveConflict(
        manager,
        event,
        current?.lastEventId ?? null,
        'El pedido cambió desde la base revisada.',
      );
    }
    if (fulfilment) {
      const effects = new SupplierReceiptEffects(manager, event, current!);
      const reason = await effects.validate();
      if (reason)
        return this.saveConflict(manager, event, current!.lastEventId, reason);
      const saved = await this.saveEvent(
        manager,
        event,
        EventSyncStatus.SYNCED,
      );
      await effects.apply(saved);
      await manager.insert(
        EventRefEntity,
        effects.refs.map((r) => ({
          ...r,
          eventRefId: randomUUID(),
          eventId: event.event_id,
          serverSequence: saved.serverSequence,
          source: 'server',
        })),
      );
      return this.result(saved, 'accepted');
    }
    if (
      current &&
      current.status !== 'draft' &&
      !(cancelled && current.status === 'confirmed')
    ) {
      return this.saveConflict(
        manager,
        event,
        current.lastEventId,
        'El estado del pedido no admite esta operación.',
      );
    }
    if (
      cancelled &&
      (
        await manager.query(
          'SELECT 1 FROM supplier_receipts WHERE order_id=$1 LIMIT 1',
          [orderId],
        )
      ).length
    ) {
      return this.saveConflict(
        manager,
        event,
        current?.lastEventId ?? null,
        'El pedido tiene recepciones; solo se podrá cerrar el remanente.',
      );
    }
    const refs: { refType: string; refId: string; relationship: string }[] = [
      { refType: 'supplier_order', refId: orderId, relationship: 'affects' },
    ];
    if (doc) {
      if (current && current.supplierId !== doc.supplierId)
        return this.saveConflict(
          manager,
          event,
          current.lastEventId,
          'El proveedor del pedido no cambia.',
        );
      const catalog: any[] = await manager.query(
        `SELECT v.variant_id,v.product_id,v.inventory_item_id,p.sale_mode,p.price_reference_quantity_atomic,
        i.default_unit_id,u.dimension,u.atomic_factor FROM product_variants v JOIN products p ON p.product_id=v.product_id
        JOIN inventory_items i ON i.inventory_item_id=v.inventory_item_id JOIN units u ON u.unit_id=i.default_unit_id
        JOIN variant_suppliers vs ON vs.variant_id=v.variant_id AND vs.supplier_id=$1 JOIN suppliers s ON s.supplier_id=vs.supplier_id
        WHERE v.variant_id = ANY($2::uuid[]) AND v.active AND p.active AND i.active AND u.active AND s.active
          AND NOT EXISTS(SELECT 1 FROM recipe_components rc WHERE rc.variant_id=v.variant_id)
          AND (p.sale_mode='unit' AND u.dimension='count' OR p.sale_mode='measured' AND (SELECT dimension FROM units su WHERE su.unit_id=p.sale_unit_id)=u.dimension AND u.dimension IN ('mass','volume'))
        FOR SHARE OF v,p,i,u,vs,s`,
        [doc.supplierId, doc.items.map((l) => l.variantId)],
      );
      const reused: any[] = await manager.query(
        `SELECT e.aggregate_id,l->>'id' line_id,l->>'variant_id' variant_id
        FROM events e CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.payload->'items','[]'::jsonb)) l
        WHERE e.aggregate_type='supplier_order' AND e.sync_status='synced' AND l->>'id'=ANY($1::text[])`,
        [doc.items.map((l) => l.id)],
      );
      if (
        reused.some(
          (r) =>
            r.aggregate_id !== orderId ||
            doc!.items.find((l) => l.id === r.line_id)!.variantId !==
              r.variant_id,
        )
      ) {
        return this.saveConflict(
          manager,
          event,
          current?.lastEventId ?? null,
          'Identidad de partida histórica ocupada.',
        );
      }
      const old = current
        ? await manager.findBy(SupplierOrderItemEntity, { orderId })
        : [];
      for (const l of doc.items) {
        const c = catalog.find((c) => c.variant_id === l.variantId);
        if (
          !c ||
          c.inventory_item_id !== l.inventoryItemId ||
          c.default_unit_id !== l.unitId ||
          c.dimension !== l.dimension ||
          Number(c.atomic_factor) !== l.unitAtomicFactor ||
          (c.sale_mode === 'unit'
            ? 1
            : Number(c.price_reference_quantity_atomic)) !==
            l.referenceQuantityAtomic ||
          old.some((o) => o.id === l.id && o.variantId !== l.variantId)
        ) {
          return this.saveConflict(
            manager,
            event,
            current?.lastEventId ?? null,
            'Cambió la elegibilidad, recurso o unidad de una partida.',
          );
        }
        refs.push(
          { refType: 'product', refId: c.product_id, relationship: 'uses' },
          {
            refType: 'product_variant',
            refId: l.variantId,
            relationship: 'uses',
          },
          {
            refType: 'inventory_item',
            refId: l.inventoryItemId,
            relationship: 'uses',
          },
          { refType: 'unit', refId: l.unitId, relationship: 'uses' },
        );
      }
      refs.push({
        refType: 'supplier',
        refId: doc.supplierId,
        relationship: 'uses',
      });
    } else if (current)
      refs.push({
        refType: 'supplier',
        refId: current.supplierId,
        relationship: 'uses',
      });
    const saved = await this.saveEvent(manager, event, EventSyncStatus.SYNCED);
    if (doc) {
      await manager.save(SupplierOrderEntity, {
        id: orderId,
        supplierId: doc.supplierId,
        status,
        occurredAtMs: String(doc.occurredAtMs),
        currency: doc.currency,
        supplierNameSnapshot: doc.supplierNameSnapshot,
        supplierPhoneSnapshot: doc.supplierPhoneSnapshot,
        notes: doc.notes,
        totalMinor: doc.totalMinor === null ? null : String(doc.totalMinor),
        active: true,
        version: (current?.version ?? 0) + 1,
        createdEventId: current?.createdEventId ?? event.event_id,
        lastEventId: event.event_id,
        lastServerSequence: saved.serverSequence,
      });
      await manager.delete(SupplierOrderItemEntity, { orderId });
      await manager.insert(
        SupplierOrderItemEntity,
        doc.items.map((l, position) => ({
          id: l.id,
          orderId,
          variantId: l.variantId,
          inventoryItemId: l.inventoryItemId,
          unitId: l.unitId,
          productNameSnapshot: l.productNameSnapshot,
          variantNameSnapshot: l.variantNameSnapshot,
          dimension: l.dimension,
          unitCodeSnapshot: l.unitCodeSnapshot,
          unitSymbolSnapshot: l.unitSymbolSnapshot,
          unitAtomicFactor: String(l.unitAtomicFactor),
          referenceQuantityAtomic: String(l.referenceQuantityAtomic),
          quantityAtomic: String(l.quantityAtomic),
          quotedPriceMinor:
            l.quotedPriceMinor === null ? null : String(l.quotedPriceMinor),
          totalMinor: l.totalMinor === null ? null : String(l.totalMinor),
          closedQuantityAtomic: '0',
          position: String(position),
        })),
      );
    } else
      await manager.update(
        SupplierOrderEntity,
        { id: orderId },
        {
          status,
          version: current!.version + 1,
          lastEventId: event.event_id,
          lastServerSequence: saved.serverSequence,
        },
      );
    const unique = [
      ...new Map(
        refs.map((r) => [r.refType + ':' + r.refId + ':' + r.relationship, r]),
      ).values(),
    ];
    await manager.insert(
      EventRefEntity,
      unique.map((r) => ({
        ...r,
        eventRefId: randomUUID(),
        eventId: saved.eventId,
        serverSequence: saved.serverSequence,
        source: 'server',
      })),
    );
    return this.result(saved, 'accepted');
  }
  async saveUniqueViolationConflict(
    manager: EntityManager,
    event: PushEventDto,
  ): Promise<PushEventResultDto> {
    const current = await manager.findOneBy(SupplierOrderEntity, {
      id: event.aggregate_id,
    });
    return this.saveConflict(
      manager,
      event,
      current?.lastEventId ?? null,
      'Identidad de pedido o partida ocupada.',
    );
  }
  private async saveConflict(
    manager: EntityManager,
    event: PushEventDto,
    winner: string | null,
    reason: string,
  ): Promise<PushEventResultDto> {
    const saved = await this.saveEvent(
      manager,
      event,
      EventSyncStatus.CONFLICT,
      reason,
    );
    await this.saveRef(manager, saved);
    const conflict = await this.conflicts.recordConflict(manager, {
      conflictType: 'stale_base_conflict',
      refType: 'supplier_order',
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
      refType: 'supplier_order',
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
