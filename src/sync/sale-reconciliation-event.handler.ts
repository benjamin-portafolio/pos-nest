import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { CashMovementEntity } from '../entities/cash-movement.entity';
import { CustomerCreditProjector } from './customer-credit.projector';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { SaleEntity } from '../entities/sale.entity';
import { SaleAdjustmentEntity } from '../entities/sale-adjustment.entity';
import { SaleReconciliationEffectEntity } from '../entities/sale-reconciliation-effect.entity';
import { InventoryItemEntity } from '../entities/inventory-item.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { CashSessionEntity } from '../entities/cash-session.entity';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { SyncConflictParticipantEntity } from '../entities/sync-conflict-participant.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { SyncConflictStatus } from '../enums/sync-conflict-status.enum';
import { PushEventDto, PushEventResultDto } from './dto/push-events.dto';
import {
  OperacionVentaConciliadaPayload,
  SaleReconciliationData,
} from './payloads/operacion-venta-conciliada.payload';
import { parseSaleAdjustmentPayload } from './payloads/sale-adjustment-data';
import { saleReconciliationEvidence } from './payloads/sale-reconciliation-evidence';
import { SaleAdjustmentRules } from './payloads/sale-adjustment-rules';
import { VentaConfirmadaPayload } from './payloads/venta-confirmada.payload';

export class SaleReconciliationEventHandler {
  async apply(
    m: EntityManager,
    e: PushEventDto,
    outcome: (
      status: 'conflict' | 'rejected',
      reason: string,
      winner?: string,
    ) => Promise<PushEventResultDto>,
  ): Promise<PushEventResultDto> {
    let contract: OperacionVentaConciliadaPayload, p: SaleReconciliationData;
    try {
      contract = OperacionVentaConciliadaPayload.fromJson(e.payload);
      p = contract.data;
      if (
        e.event_id !== p.event_id ||
        e.aggregate_id !== p.sale_id ||
        e.aggregate_type !== 'sale' ||
        e.base_version !== p.expected_revision + 1 ||
        new Date(e.created_at_local).getTime() !== p.occurred_at_ms
      )
        throw new Error('Sobre de conciliación inválido.');
    } catch (error) {
      return outcome('rejected', (error as Error).message);
    }
    // Las recuperaciones se serializan por caja antes de cuenta/venta.
    for (const id of [
      ...new Set(
        p.recovery_effects
          .filter((x) => x.ledger === 'cash' && x.cash_session_id)
          .map((x) => x.cash_session_id!),
      ),
    ].sort()) {
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'cash:device:' + e.device_id,
      ]);
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'cash:session:' + id,
      ]);
      await m.findOne(CashSessionEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
    }
    for (const id of [
      ...new Set(
        [...p.preserved_effects, ...p.recovery_effects]
          .filter((x) => x.ledger === 'credit')
          .map((x) => x.target_id),
      ),
    ].sort())
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'customer_account:' + id,
      ]);
    await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'sale:' + p.sale_id,
    ]);
    await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'sale_reconciliation_operation:' + p.operation_id,
    ]);
    const loser = await m.findOneBy(EventEntity, { eventId: p.loser_event_id });
    if (!loser || loser.syncStatus === EventSyncStatus.PENDING)
      return {
        event_id: e.event_id,
        status: 'pending',
        server_sequence: null,
        created_at_server: null,
        reason: 'Reporta primero la incidencia local.',
      };
    if (
      loser.aggregateId !== p.sale_id ||
      loser.deviceId !== e.device_id ||
      ![EventSyncStatus.CONFLICT, EventSyncStatus.REJECTED].includes(
        loser.syncStatus,
      )
    )
      return outcome(
        'rejected',
        'La evidencia no pertenece a una operación terminal de esta terminal.',
      );
    const sale = await m.findOneBy(SaleEntity, { id: p.sale_id });
    if (!sale?.createdEventId)
      return outcome('rejected', 'Venta confirmada ausente.');
    const docs = await m.find(SaleAdjustmentEntity, {
      where: { saleId: p.sale_id },
      order: { revision: 'ASC' },
    });
    const base = docs.at(-1)?.eventId ?? sale.createdEventId;
    const official = await m.findOneByOrFail(EventEntity, { eventId: base });
    if (
      p.expected_revision !== docs.length ||
      p.official_base_event_id !== base ||
      String(e.base_server_sequence) !== official.serverSequence
    )
      return outcome(
        'conflict',
        'Revisión oficial obsoleta al conciliar.',
        base,
      );
    const winner = await m.findOneBy(EventEntity, {
      eventId: p.winner_event_id,
    });
    if (
      !winner ||
      winner.aggregateId !== p.sale_id ||
      winner.syncStatus !== EventSyncStatus.SYNCED ||
      (!docs.some((d) => d.eventId === winner.eventId) &&
        winner.eventId !== sale.createdEventId)
    )
      return outcome('rejected', 'Ganador oficial incompatible.');
    const consumed = await m
      .createQueryBuilder(EventEntity, 'e')
      .where(
        "e.event_type=:type AND e.sync_status=:status AND (e.payload->>'loser_event_id'=:loser OR e.payload->>'operation_id'=:operation)",
        {
          type: OperacionVentaConciliadaPayload.eventType,
          status: EventSyncStatus.SYNCED,
          loser: p.loser_event_id,
          operation: p.operation_id,
        },
      )
      .getOne();
    if (consumed)
      return outcome(
        'rejected',
        'Incidencia o identidad de operación ya consumida.',
      );
    try {
      const frozen = parseSaleAdjustmentPayload(loser.payload);
      // Un rechazo no convierte un payload manipulado en evidencia admisible.
      const confirmation = await m.findOneByOrFail(EventEntity, {
        eventId: sale.createdEventId,
      });
      const history = [] as ReturnType<typeof parseSaleAdjustmentPayload>[];
      let ancestor = frozen.previous_adjustment_event_id;
      const seen = new Set<string>();
      while (ancestor) {
        if (seen.has(ancestor))
          throw new Error('Ciclo en la evidencia histórica.');
        seen.add(ancestor);
        const source = await m.findOneBy(EventEntity, { eventId: ancestor });
        if (!source || source.aggregateId !== p.sale_id)
          throw new Error('Falta historia de la intención perdedora.');
        const payload = parseSaleAdjustmentPayload(source.payload);
        history.unshift(payload);
        ancestor = payload.previous_adjustment_event_id;
      }
      SaleAdjustmentRules.validate(
        frozen,
        VentaConfirmadaPayload.fromJson(confirmation.payload),
        confirmation.eventId,
        sale.id,
        history,
      );
      contract.validateIncident(
        p.loser_event_id,
        p.sale_id,
        loser.eventId,
        winner.eventId,
        base,
        docs.length,
        saleReconciliationEvidence(frozen),
        false,
      );
      const totals = new Map<string, number>();
      for (const r of p.recovery_effects) {
        if (r.occurred_at_ms < frozen.occurred_at_ms)
          throw new Error(
            'La recuperación debe ser posterior a la operación local.',
          );
        const key = r.ledger + '/' + r.target_id;
        totals.set(key, (totals.get(key) ?? 0) + r.delta);
        const preserved = p.preserved_effects
          .filter((x) => x.ledger === r.ledger && x.target_id === r.target_id)
          .reduce((n, x) => n + x.delta, 0);
        if (
          !preserved ||
          Math.sign(totals.get(key)!) === Math.sign(preserved) ||
          Math.abs(totals.get(key)!) > Math.abs(preserved)
        )
          throw new Error('Recuperación sin diferencia justificada.');
        if (r.ledger === 'cash' && r.cash_session_id) {
          const s = await m.findOneBy(CashSessionEntity, {
            id: r.cash_session_id,
          });
          if (
            !s ||
            s.status !== 'open' ||
            s.deviceId !== e.device_id ||
            s.createdEventId !== r.opening_event_id ||
            BigInt(r.occurred_at_ms) < BigInt(s.openedAtMs)
          )
            throw new Error('La recuperación exige caja actual abierta.');
        }
      }
    } catch (error) {
      return outcome('rejected', (error as Error).message);
    }
    for (const x of p.preserved_effects.filter(
      (x) => x.ledger === 'cash' && x.cash_session_id,
    )) {
      const opening = await m.findOneBy(EventEntity, {
        eventId: x.opening_event_id!,
      });
      if (!opening || opening.syncStatus === EventSyncStatus.PENDING)
        return {
          event_id: e.event_id,
          status: 'pending',
          server_sequence: null,
          created_at_server: null,
          reason: 'Apertura histórica de la evidencia pendiente.',
        };
      const session = await m.findOneBy(CashSessionEntity, {
        id: x.cash_session_id!,
      });
      if (
        opening.syncStatus !== EventSyncStatus.SYNCED ||
        !session ||
        session.deviceId !== loser.deviceId ||
        session.createdEventId !== x.opening_event_id
      )
        return outcome(
          'rejected',
          'La caja histórica de la evidencia requiere atención.',
        );
    }
    const effects = [...p.preserved_effects, ...p.recovery_effects];
    if (await m.existsBy(SaleAdjustmentEntity, { id: p.operation_id }))
      return outcome('rejected', 'Identidad de documento ya utilizada.');
    for (const x of effects) {
      if (
        (await m.existsBy(InventoryMovementEntity, {
          movementId: x.effect_id,
        })) ||
        (await m.existsBy(CashMovementEntity, { id: x.effect_id })) ||
        (await m.existsBy(SaleAdjustmentEntity, { id: x.effect_id }))
      )
        return outcome(
          'rejected',
          'Identidad física ya pertenece a otra operación oficial.',
        );
    }
    const stock = new Map<string, bigint>();
    for (const x of effects)
      if (x.ledger === 'stock')
        stock.set(
          x.target_id,
          (stock.get(x.target_id) ?? 0n) + BigInt(x.delta),
        );
    for (const id of [...stock.keys()].sort())
      await m.findOneOrFail(InventoryItemEntity, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
    const balances: InventoryBalanceEntity[] = [];
    for (const id of [...stock.keys()].sort()) {
      const b = await m.findOneOrFail(InventoryBalanceEntity, {
        where: { inventoryItemId: id },
        lock: { mode: 'pessimistic_write' },
      });
      for (const value of [
        BigInt(b.quantityOnHandAtomic) + stock.get(id)!,
        BigInt(b.quantityAvailableAtomic) + stock.get(id)!,
      ])
        if (
          value > BigInt(Number.MAX_SAFE_INTEGER) ||
          value < BigInt(-Number.MAX_SAFE_INTEGER)
        )
          return outcome('rejected', 'Saldo fuera de rango.');
      b.quantityOnHandAtomic = String(
        BigInt(b.quantityOnHandAtomic) + stock.get(id)!,
      );
      b.quantityAvailableAtomic = String(
        BigInt(b.quantityAvailableAtomic) + stock.get(id)!,
      );
      balances.push(b);
    }
    const saved = await m.save(
      m.create(EventEntity, {
        eventId: e.event_id,
        aggregateType: 'sale',
        aggregateId: p.sale_id,
        eventType: e.event_type,
        deviceId: e.device_id,
        userId: e.user_id,
        localSequence: e.local_sequence ?? null,
        baseVersion: e.base_version,
        baseServerSequence: String(e.base_server_sequence),
        createdAtLocal: new Date(e.created_at_local),
        payload: contract.toJson(),
        syncStatus: EventSyncStatus.SYNCED,
      }),
    );
    for (const x of effects)
      await m.save(
        m.create(SaleReconciliationEffectEntity, {
          effectId: x.effect_id,
          eventId: e.event_id,
          ledger: x.ledger,
          targetId: x.target_id,
          delta: String(x.delta),
          cashSessionId: x.cash_session_id,
          isRecovery: p.recovery_effects.some(
            (r) => r.effect_id === x.effect_id,
          ),
          payload: { ...x },
        }),
      );
    for (const b of balances) {
      b.lastEventId = e.event_id;
      b.lastServerSequence = saved.serverSequence;
      await m.save(b);
    }
    for (const r of contract.refs())
      await m.insert(EventRefEntity, {
        eventRefId: randomUUID(),
        eventId: e.event_id,
        refType: r.ref_type,
        refId: r.ref_id,
        relationship: r.relationship,
        source: 'server',
        serverSequence: saved.serverSequence,
      });
    for (const id of [
      ...new Set(
        effects.filter((x) => x.ledger === 'credit').map((x) => x.target_id),
      ),
    ])
      await new CustomerCreditProjector().rebuild(m, id);
    for (const participant of await m.find(SyncConflictParticipantEntity, {
      where: { eventId: p.loser_event_id },
    }))
      await m.update(
        SyncConflictEntity,
        { conflictId: participant.conflictId },
        { status: SyncConflictStatus.RESOLVED, resolutionEventId: e.event_id },
      );
    return {
      event_id: e.event_id,
      status: 'accepted',
      server_sequence: Number(saved.serverSequence),
      created_at_server: saved.createdAtServer.toISOString(),
    };
  }
}
