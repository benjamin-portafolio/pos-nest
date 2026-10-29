import { SaleReconciliationEventHandler } from './sale-reconciliation-event.handler';
import { OperacionVentaConciliadaPayload } from './payloads/operacion-venta-conciliada.payload';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { SaleEntity } from '../entities/sale.entity';
import { SaleAdjustmentEntity } from '../entities/sale-adjustment.entity';
import { SaleAdjustmentLineEntity } from '../entities/sale-adjustment-line.entity';
import { SaleCreditReductionEntity } from '../entities/sale-credit-reduction.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { CreditSaleEntity } from '../entities/credit-sale.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import { VentaAnuladaPayload } from './payloads/venta-anulada.payload';
import { DevolucionVentaRegistradaPayload } from './payloads/devolucion-venta-registrada.payload';
import { VentaConfirmadaPayload } from './payloads/venta-confirmada.payload';
import { SaleAdjustmentRules } from './payloads/sale-adjustment-rules';
import {
  parseSaleAdjustmentPayload,
  SaleAdjustmentPayloadData,
} from './payloads/sale-adjustment-data';
import {
  adjustmentDuplicateMatches,
  isSaleAdjustment,
} from './payloads/sale-adjustment-identity';
import { CustomerCreditProjector } from './customer-credit.projector';
import { SyncConflictService } from './sync-conflict.service';
@Injectable()
export class SaleAdjustmentEventHandler {
  constructor(
    private readonly credits: CustomerCreditProjector,
    private readonly conflicts: SyncConflictService,
  ) {}
  supports(type: string): boolean {
    return isSaleAdjustment(type);
  }
  async apply(m: EntityManager, e: PushEventDto): Promise<PushEventResultDto> {
    if(e.event_type===OperacionVentaConciliadaPayload.eventType) return new SaleReconciliationEventHandler().apply(m,e,(status,reason,winner)=>this.outcome(m,e,status,reason,winner));
    let p: SaleAdjustmentPayloadData;
    try {
      p = (
        e.event_type === VentaAnuladaPayload.eventType
          ? VentaAnuladaPayload.fromJson(e.payload)
          : DevolucionVentaRegistradaPayload.fromJson(e.payload)
      ).adjustment;
      if (
        !e.device_id?.trim() || !e.user_id?.trim() || e.aggregate_type !== 'sale' ||
        e.aggregate_id !== p.sale_id ||
        e.event_id !== p.event_id ||
        e.base_version !== p.expected_revision + 1 ||
        new Date(e.created_at_local).getTime() !== p.occurred_at_ms
      )
        throw new Error('Sobre de ajuste inválido.');
    } catch (error) {
      return this.rejected(e, (error as Error).message);
    }
    // El envoltorio de caja toma dispositivo/sesión antes de entrar aquí.
    if (p.settlement.cliente_id)
      await this.credits.lock(m, p.settlement.cliente_id);
    await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      'sale:' + p.sale_id,
    ]);
    const duplicate = await m.findOneBy(EventEntity, { eventId: e.event_id });
    if (duplicate)
      return adjustmentDuplicateMatches(e, duplicate)
        ? this.result(duplicate, 'duplicate')
        : this.rejected(e, 'El event_id ya existe con otro contenido.');
    if (await m.existsBy(SaleAdjustmentEntity, { id: p.operation_id }))
      return this.rejected(e, 'operation_id ya utilizado.');
    for (const id of p.dependency_event_ids) {
      const dep = await m.findOneBy(EventEntity, { eventId: id });
      if (!dep || dep.syncStatus === EventSyncStatus.PENDING)
        return {
          event_id: e.event_id,
          status: 'pending',
          server_sequence: null,
          created_at_server: null,
          reason: 'Dependencia pendiente: ' + id,
        };
      if (dep.syncStatus !== EventSyncStatus.SYNCED)
        return this.outcome(
          m,
          e,
          'conflict',
          'Dependencia con incidencia: ' + id,
        );
    }
    const sale = await m.findOneBy(SaleEntity, { id: p.sale_id });
    const confirmation = sale?.createdEventId
      ? await m.findOneBy(EventEntity, { eventId: sale.createdEventId })
      : null;
    if (
      !sale ||
      !confirmation ||
      confirmation.eventType !== VentaConfirmadaPayload.eventType ||
      confirmation.syncStatus !== EventSyncStatus.SYNCED ||
      confirmation.eventId !== p.confirmation_event_id
    )
      return this.outcome(
        m,
        e,
        'rejected',
        'Confirmación histórica incompatible.',
      );
    const documents = await m.find(SaleAdjustmentEntity, {
      where: { saleId: p.sale_id },
      order: { revision: 'ASC' },
    });
    const history: SaleAdjustmentPayloadData[] = [];
    for (const d of documents)
      history.push(
        parseSaleAdjustmentPayload(
          (await m.findOneByOrFail(EventEntity, { eventId: d.eventId }))
            .payload,
        ),
      );
    const base = documents.at(-1)?.eventId ?? confirmation.eventId;
    const official = await m.findOneByOrFail(EventEntity, { eventId: base });
    if (
      p.expected_revision !== documents.length ||
      p.previous_adjustment_event_id !== (documents.at(-1)?.eventId ?? null) ||
      String(e.base_server_sequence) !== official.serverSequence
    )
      return this.outcome(
        m,
        e,
        'conflict',
        'Revisión/base oficial obsoleta.',
        base,
      );
    const original = VentaConfirmadaPayload.fromJson(confirmation.payload);
    try {
      SaleAdjustmentRules.validate(
        p,
        original,
        confirmation.eventId,
        sale.id,
        history,
      );
    } catch (error) {
      return this.outcome(m, e, 'rejected', (error as Error).message);
    }
    const deltas = new Map<string, bigint>();
    for (const l of p.lines)
      for (const s of l.stock) {
        const source = await m.findOneBy(InventoryMovementEntity, {
          movementId: s.original_movement_id,
        });
        if (
          !source ||
          source.eventId !== confirmation.eventId ||
          source.saleItemId !== l.sale_item_id ||
          source.inventoryItemId !== s.inventory_item_id ||
          source.movementType !== 'sale_consumption'
        )
          return this.outcome(
            m,
            e,
            'rejected',
            'Consumo histórico incompatible.',
          );
        deltas.set(
          s.inventory_item_id,
          (deltas.get(s.inventory_item_id) ?? 0n) + BigInt(s.quantity_atomic),
        );
      }
    const balances: InventoryBalanceEntity[] = [];
    for (const id of [...deltas.keys()].sort())
      await m.findOneOrFail(InventoryItemEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
    for (const id of [...deltas.keys()].sort()) {
      const b = await m.findOneOrFail(InventoryBalanceEntity, {
        where: { inventoryItemId: id },
        lock: { mode: 'pessimistic_write' },
      });
      const onHand = BigInt(b.quantityOnHandAtomic) + deltas.get(id)!,
        available = BigInt(b.quantityAvailableAtomic) + deltas.get(id)!;
      if (
        onHand > BigInt(Number.MAX_SAFE_INTEGER) ||
        available > BigInt(Number.MAX_SAFE_INTEGER)
      )
        return this.outcome(m, e, 'rejected', 'Saldo fuera de rango.');
      b.quantityOnHandAtomic = String(onHand);
      b.quantityAvailableAtomic = String(available);
      balances.push(b);
    }
    const saved = await this.save(
      m,
      { ...e, payload: { ...p } },
      EventSyncStatus.SYNCED,
    );
    const metadata = {
      createdEventId: e.event_id,
      lastEventId: e.event_id,
      lastServerSequence: saved.serverSequence,
    };
    await m.insert(SaleAdjustmentEntity, {
      ...metadata,
      id: p.operation_id,
      eventId: e.event_id,
      saleId: p.sale_id,
      revision: p.expected_revision + 1,
      kind: p.kind,
      reason: p.reason,
      totalMinor: String(p.total_minor),
      occurredAtMs: String(p.occurred_at_ms),
      utcOffsetMinutes: p.utc_offset_minutes,
      businessDate: p.business_date,
      currency: p.currency,
      method: p.settlement.method,
      settlementAction: p.settlement.action,
      reference: p.settlement.reference,
      paymentId: p.settlement.payment_id,
      clienteId: p.settlement.cliente_id,
    });
    for (const l of p.lines) {
      await m.insert(SaleAdjustmentLineEntity, {
        operationId: p.operation_id,
        saleItemId: l.sale_item_id,
        quantityAtomic: String(l.quantity_atomic),
        amountMinor: String(l.amount_minor),
        recoveredCostMinor:
          l.recovered_cost_minor === null
            ? null
            : String(l.recovered_cost_minor),
        destination: l.destination,
        reason: l.reason,
      });
      for (const s of l.stock)
        await m.insert(InventoryMovementEntity, {
          movementId: s.movement_id,
          inventoryItemId: s.inventory_item_id,
          saleItemId: l.sale_item_id,
          saleAdjustmentId: p.operation_id,
          eventId: e.event_id,
          reversalOfMovementId: s.original_movement_id,
          movementType:
            p.kind === 'void' ? 'sale_void_restock' : 'sale_return_restock',
          quantityDeltaAtomic: String(s.quantity_atomic),
          createdAtLocal: new Date(e.created_at_local),
          serverSequence: saved.serverSequence,
        });
    }
    for (const b of balances)
      await m.save(InventoryBalanceEntity, {
        ...b,
        version: b.version + 1,
        lastEventId: e.event_id,
        lastServerSequence: saved.serverSequence,
      });
    if (p.settlement.method === 'credit' && p.total_minor > 0) {
      const credit = await m.findOneByOrFail(CreditSaleEntity, {
        saleId: p.sale_id,
      });
      if (
        credit.clienteId !== p.settlement.cliente_id ||
        credit.createdEventId !== confirmation.eventId
      )
        throw new Error('Cargo histórico incompatible.');
      await m.insert(SaleCreditReductionEntity, {
        operationId: p.operation_id,
        creditId: credit.id,
        amountMinor: String(p.total_minor),
      });
      await this.credits.rebuild(m, credit.clienteId);
    }
    for (const r of SaleAdjustmentRules.refs(p, original))
      await m.insert(EventRefEntity, {
        eventRefId: randomUUID(),
        eventId: e.event_id,
        refType: r.ref_type,
        refId: r.ref_id,
        relationship: r.relationship,
        source: 'server',
        serverSequence: saved.serverSequence,
      });
    return this.result(saved, 'accepted');
  }
  async outcome(
    m: EntityManager,
    e: PushEventDto,
    status: 'conflict' | 'rejected',
    reason: string,
    winner: string | null = null,
  ): Promise<PushEventResultDto> {
    const saved = await this.save(
      m,
      e,
      status === 'conflict'
        ? EventSyncStatus.CONFLICT
        : EventSyncStatus.REJECTED,
      reason,
    );
    await m.insert(EventRefEntity, {
      eventRefId: randomUUID(),
      eventId: e.event_id,
      refType: 'sale',
      refId: e.aggregate_id,
      relationship: 'affects',
      source: 'server',
      serverSequence: saved.serverSequence,
    });
    if (status === 'conflict') {
      const c = await this.conflicts.recordConflict(m, {
        conflictType: 'sale_adjustment_revision',
        refType: 'sale',
        refId: e.aggregate_id,
        reason,
        losingEvent: saved,
        defaultWinnerEventId: winner,
      });
      return { ...this.result(saved, status), conflict_id: c.conflictId };
    }
    return this.result(saved, status);
  }
  private save(
    m: EntityManager,
    e: PushEventDto,
    status: EventSyncStatus,
    reason: string | null = null,
  ): Promise<EventEntity> {
    return m.save(
      m.create(EventEntity, {
        eventId: e.event_id,
        aggregateType: e.aggregate_type,
        aggregateId: e.aggregate_id,
        eventType: e.event_type,
        deviceId: e.device_id,
        userId: e.user_id,
        localSequence: e.local_sequence ?? null,
        baseVersion: e.base_version,
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
  private result(
    e: EventEntity,
    status: PushEventResultDto['status'],
  ): PushEventResultDto {
    return {
      event_id: e.eventId,
      status,
      server_sequence: Number(e.serverSequence),
      created_at_server: e.createdAtServer.toISOString(),
      reason: e.rejectionReason ?? undefined,
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
