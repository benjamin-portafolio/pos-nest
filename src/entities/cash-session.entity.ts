import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
/** Una caja por dispositivo. Estado operativo independiente de events.sync_status. */
@Entity({ name: 'cash_sessions' })
@Index('uq_cash_session_open_device', ['deviceId'], { unique: true, where: "status = 'open'" })
@Check('ck_cash_session_state', "status IN ('open','closed')")
@Check('ck_cash_session_amount', 'opening_minor >= 0 AND opening_minor <= 9007199254740991 AND (counted_minor IS NULL OR counted_minor BETWEEN 0 AND 9007199254740991)')
@Check('ck_cash_session_close', "(status = 'open' AND closed_at_ms IS NULL AND closed_by_user_id IS NULL AND counted_minor IS NULL AND close_snapshot IS NULL AND income_minor IS NULL AND expense_minor IS NULL AND expected_minor IS NULL AND difference_minor IS NULL) OR (status = 'closed' AND closed_at_ms IS NOT NULL AND closed_by_user_id IS NOT NULL AND counted_minor IS NOT NULL AND close_snapshot IS NOT NULL AND income_minor IS NOT NULL AND expense_minor IS NOT NULL AND expected_minor IS NOT NULL AND difference_minor IS NOT NULL)")
export class CashSessionEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('text', { name: 'device_id' }) deviceId: string;
  @Column('text', { name: 'opened_by_user_id' }) openedByUserId: string;
  @Column('text', { name: 'closed_by_user_id', nullable: true }) closedByUserId: string | null;
  @Column('text') status: string;
  @Column('bigint', { name: 'opened_at_ms' }) openedAtMs: string;
  @Column('bigint', { name: 'closed_at_ms', nullable: true }) closedAtMs: string | null;
  @Column('bigint', { name: 'opening_minor' }) openingMinor: string;
  @Column('bigint', { name: 'counted_minor', nullable: true }) countedMinor: string | null;
  @Column('numeric', { name: 'income_minor', nullable: true }) incomeMinor: string | null;
  @Column('numeric', { name: 'expense_minor', nullable: true }) expenseMinor: string | null;
  @Column('numeric', { name: 'expected_minor', nullable: true }) expectedMinor: string | null;
  @Column('numeric', { name: 'difference_minor', nullable: true }) differenceMinor: string | null;
  @Column('jsonb', { name: 'close_snapshot', nullable: true }) closeSnapshot: Record<string, unknown> | null;
  @Column('uuid', { name: 'previous_close_event_id', nullable: true }) previousCloseEventId: string | null;
  @Column('text', { nullable: true }) notes: string | null;
}
