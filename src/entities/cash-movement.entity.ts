import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
import { CashSessionEntity } from './cash-session.entity';
import { SalePaymentEntity } from './sale-payment.entity';
import { CustomerPaymentEntity } from './customer-payment.entity';
import { FinancialEntryEntity } from './financial-entry.entity';
/** Movimiento inmutable de un origen real; nunca duplica el fondo inicial. */
@Entity({ name: 'cash_movements' })
@Index('ix_cash_movements_session', ['sessionId'])
@Check('ck_cash_movement_source', 'num_nonnulls(sale_payment_id, customer_payment_id, financial_entry_id) = 1')
@Check('ck_cash_movement_amount', 'amount_minor > 0 AND amount_minor <= 9007199254740991')
@Check('ck_cash_movement_direction', "direction IN ('in','out')")
export class CashMovementEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid', { name: 'session_id' }) sessionId: string;
  @ManyToOne(() => CashSessionEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'session_id' }) session: CashSessionEntity;
  @Column('text') direction: string;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
  @Column('uuid', { name: 'sale_payment_id', nullable: true, unique: true }) salePaymentId: string | null;
  @ManyToOne(() => SalePaymentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sale_payment_id' }) salePayment: SalePaymentEntity | null;
  @Column('uuid', { name: 'customer_payment_id', nullable: true, unique: true }) customerPaymentId: string | null;
  @ManyToOne(() => CustomerPaymentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_payment_id' }) customerPayment: CustomerPaymentEntity | null;
  @Column('uuid', { name: 'financial_entry_id', nullable: true, unique: true }) financialEntryId: string | null;
  @ManyToOne(() => FinancialEntryEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'financial_entry_id' }) financialEntry: FinancialEntryEntity | null;
}
