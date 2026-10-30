import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { EventEntity } from './event.entity';
import { CashSessionEntity } from './cash-session.entity';
/** Libro inmutable de diferencias reconocidas. Identidad física única, sin
 * versión comercial ni incremento de cantidades devueltas. Los cortes cerrados
 * conservan su evidencia; estos efectos pertenecen a una regularización aparte. */
@Entity('sale_reconciliation_effects')
@Check(
  'sale_reconciliation_effects_ledger_check',
  "ledger IN ('stock','cash','credit','transfer')",
)
@Check(
  'sale_reconciliation_effects_delta_check',
  'delta<>0 AND abs(delta)<=9007199254740991',
)
export class SaleReconciliationEffectEntity {
  @PrimaryColumn('uuid', { name: 'effect_id' }) effectId: string;
  @Column('uuid', { name: 'event_id' }) eventId: string;
  @ManyToOne(() => EventEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'sale_reconciliation_effects_event_id_fkey',
  })
  event: EventEntity;
  @Column('text') ledger: string;
  @Column('uuid', { name: 'target_id' }) targetId: string;
  @Column('bigint') delta: string;
  @Column('uuid', { name: 'cash_session_id', nullable: true }) cashSessionId:
    | string
    | null;
  @ManyToOne(() => CashSessionEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'cash_session_id',
    foreignKeyConstraintName:
      'sale_reconciliation_effects_cash_session_id_fkey',
  })
  cashSession: CashSessionEntity | null;
  @Column('boolean', { name: 'is_recovery' }) isRecovery: boolean;
  @Column('jsonb') payload: Record<string, unknown>;
}
