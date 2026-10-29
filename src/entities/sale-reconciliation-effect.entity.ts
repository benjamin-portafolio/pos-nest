import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { EventEntity } from './event.entity';
/** Libro inmutable de diferencias reconocidas. Identidad física única, sin
 * versión comercial ni incremento de cantidades devueltas. Los cortes cerrados
 * conservan su evidencia; estos efectos pertenecen a una regularización aparte. */
@Entity('sale_reconciliation_effects')
export class SaleReconciliationEffectEntity {
  @PrimaryColumn('uuid', { name: 'effect_id' }) effectId: string;
  @Column('uuid', { name: 'event_id' }) eventId: string;
  @ManyToOne(() => EventEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event: EventEntity;
  @Column('text') ledger: string;
  @Column('uuid', { name: 'target_id' }) targetId: string;
  @Column('bigint') delta: string;
  @Column('uuid', { name: 'cash_session_id', nullable: true }) cashSessionId:
    | string
    | null;
  @Column('boolean', { name: 'is_recovery' }) isRecovery: boolean;
  @Column('jsonb') payload: Record<string, unknown>;
}
