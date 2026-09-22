import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { CreditSaleEntity } from './credit-sale.entity';
import { CustomerPaymentEntity } from './customer-payment.entity';
/** Proyección FIFO reconstruible, sin evento ni identidad independiente. */
@Entity({ name: 'credit_allocations' })
@Check(
  'ck_credit_allocation_amount',
  'amount_minor > 0 AND amount_minor <= 9007199254740991',
)
export class CreditAllocationEntity {
  @PrimaryColumn('uuid', { name: 'payment_id' }) paymentId: string;
  @PrimaryColumn('uuid', { name: 'credit_id' }) creditId: string;
  @ManyToOne(() => CustomerPaymentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payment_id' })
  payment: CustomerPaymentEntity;
  @ManyToOne(() => CreditSaleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'credit_id' })
  credit: CreditSaleEntity;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
}
