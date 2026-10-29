import { id, list, number, object, text } from './sale-adjustment-data';
import { businessDate } from './sale-adjustment-data';
import { AdjustmentRef } from './sale-adjustment-rules';
export interface SaleReconciliationEffect {
  effect_id: string;
  ledger: string;
  target_id: string;
  delta: number;
  occurred_at_ms: number;
  cash_session_id: string | null;
  opening_event_id: string | null;
  utc_offset_minutes: number;
  business_date: string;
}
function effect(value: unknown): SaleReconciliationEffect {
  const j = object(value, [
    'effect_id',
    'ledger',
    'target_id',
    'delta',
    'occurred_at_ms',
    'cash_session_id',
    'opening_event_id',
    'utc_offset_minutes',
    'business_date',
  ]);
  if (
    typeof j.delta !== 'number' ||
    !Number.isSafeInteger(j.delta) ||
    j.delta === 0 ||
    !['stock', 'cash', 'credit', 'transfer'].includes(j.ledger as string)
  )
    throw new Error('Delta inválido.');
  const session = j.cash_session_id === null ? null : id(j.cash_session_id),
    opening = j.opening_event_id === null ? null : id(j.opening_event_id);
  if (
    (session === null) !== (opening === null) ||
    (j.ledger !== 'cash' && session !== null)
  )
    throw new Error('Caja inconsistente.');
  const utcOffset = number(j.utc_offset_minutes, -840);
  if (utcOffset > 840) throw new Error('Offset inválido.');
  businessDate(number(j.occurred_at_ms, 1), utcOffset, text(j.business_date));
  return {
    utc_offset_minutes: utcOffset,
    business_date: text(j.business_date),
    effect_id: id(j.effect_id),
    ledger: j.ledger as string,
    target_id: id(j.target_id),
    delta: j.delta,
    occurred_at_ms: number(j.occurred_at_ms, 1),
    cash_session_id: session,
    opening_event_id: opening,
  };
}
export interface SaleReconciliationData {
  schema_version: number;
  operation_id: string;
  event_id: string;
  incident_id: string;
  sale_id: string;
  loser_event_id: string;
  winner_event_id: string;
  official_base_event_id: string;
  expected_revision: number;
  occurred_at_ms: number;
  reason: string;
  preserved_effects: SaleReconciliationEffect[];
  recovery_effects: SaleReconciliationEffect[];
  utc_offset_minutes: number;
  business_date: string;
}
export class OperacionVentaConciliadaPayload {
  static readonly aggregateType = 'sale';
  static readonly eventType = 'operacion_venta_conciliada';
  private constructor(readonly data: SaleReconciliationData) {}
  static fromJson(
    value: Record<string, unknown>,
  ): OperacionVentaConciliadaPayload {
    const j = object(value, [
      'schema_version',
      'operation_id',
      'event_id',
      'incident_id',
      'sale_id',
      'loser_event_id',
      'winner_event_id',
      'official_base_event_id',
      'expected_revision',
      'occurred_at_ms',
      'reason',
      'preserved_effects',
      'recovery_effects',
      'utc_offset_minutes',
      'business_date',
    ]);
    if (j.schema_version !== 1) throw new Error('Versión inválida.');
    const p: SaleReconciliationData = {
      schema_version: 1,
      utc_offset_minutes: number(j.utc_offset_minutes, -840),
      business_date: text(j.business_date),
      operation_id: id(j.operation_id),
      event_id: id(j.event_id),
      incident_id: id(j.incident_id),
      sale_id: id(j.sale_id),
      loser_event_id: id(j.loser_event_id),
      winner_event_id: id(j.winner_event_id),
      official_base_event_id: id(j.official_base_event_id),
      expected_revision: number(j.expected_revision),
      occurred_at_ms: number(j.occurred_at_ms, 1),
      reason: text(j.reason),
      preserved_effects: list(j.preserved_effects, effect),
      recovery_effects: list(j.recovery_effects, effect),
    };
    if (p.utc_offset_minutes > 840) throw new Error('Offset inválido.');
    businessDate(p.occurred_at_ms, p.utc_offset_minutes, p.business_date);
    const effects = [...p.preserved_effects, ...p.recovery_effects];
    if (
      p.event_id === p.operation_id ||
      p.loser_event_id === p.winner_event_id ||
      new Set(effects.map((e) => e.effect_id)).size !== effects.length ||
      p.recovery_effects.some((e) => e.occurred_at_ms > p.occurred_at_ms)
    )
      throw new Error('Conciliación inválida.');
    if (
      effects.some(
        (e) =>
          e.effect_id === p.operation_id ||
          e.effect_id === p.event_id ||
          e.occurred_at_ms > p.occurred_at_ms,
      )
    )
      throw new Error('Identidad/fecha de efecto inválida.');
    return new OperacionVentaConciliadaPayload(p);
  }
  validateIncident(
    incident: string,
    sale: string,
    loser: string,
    winner: string,
    officialBase: string,
    revision: number,
    evidence: SaleReconciliationEffect[],
    alreadyConsumed: boolean,
  ): void {
    const p = this.data,
      actual = new Map(
        evidence.map((e) => [e.effect_id, JSON.stringify(effect(e))]),
      );
    if (
      alreadyConsumed ||
      incident !== p.incident_id ||
      sale !== p.sale_id ||
      loser !== p.loser_event_id ||
      winner !== p.winner_event_id ||
      officialBase !== p.official_base_event_id ||
      revision !== p.expected_revision ||
      actual.size !== p.preserved_effects.length ||
      p.preserved_effects.some(
        (e) => actual.get(e.effect_id) !== JSON.stringify(e),
      )
    )
      throw new Error('Incidencia, evidencia o base obsoleta.');
  }
  dependencyEventIds(): string[] {
    return [
      ...new Set([
        this.data.official_base_event_id,
        this.data.winner_event_id,
        ...this.data.recovery_effects.flatMap((e) =>
          e.opening_event_id ? [e.opening_event_id] : [],
        ),
      ]),
    ];
  }
  refs(): AdjustmentRef[] {
    const p = this.data;
    return [
      ...[
        ...new Set([
          ...this.dependencyEventIds(),
          p.loser_event_id,
          ...p.preserved_effects.flatMap((e) =>
            e.opening_event_id ? [e.opening_event_id] : [],
          ),
        ]),
      ].map(
        (id): AdjustmentRef => ({
          ref_type: 'event',
          ref_id: id,
          relationship: 'uses',
        }),
      ),
      { ref_type: 'sale', ref_id: p.sale_id, relationship: 'affects' },
      {
        ref_type: 'sale_incident',
        ref_id: p.incident_id,
        relationship: 'affects',
      },
      {
        ref_type: 'sale_reconciliation',
        ref_id: p.operation_id,
        relationship: 'affects',
      },
      ...[...p.preserved_effects, ...p.recovery_effects].flatMap(
        (e): AdjustmentRef[] => [
          {
            ref_type: 'physical_effect',
            ref_id: e.effect_id,
            relationship: 'affects',
          },
          {
            ref_type:
              e.ledger === 'stock'
                ? 'inventory_item'
                : e.ledger === 'credit'
                  ? 'customer_account'
                  : e.ledger === 'cash'
                    ? 'cash_movement'
                    : 'transfer_adjustment',
            ref_id: e.target_id,
            relationship: 'affects',
          },
          ...(e.cash_session_id
            ? [
                {
                  ref_type: 'cash_session',
                  ref_id: e.cash_session_id,
                  relationship: 'uses',
                } as AdjustmentRef,
              ]
            : []),
        ],
      ),
    ];
  }
  toJson(): Record<string, unknown> {
    return { ...this.data };
  }
}

export interface ConciliarOperacionVentaCommand {
  payload: OperacionVentaConciliadaPayload;
  userId: string;
  deviceId: string;
}
