import {
  Check,
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
import { SaleEntity } from './sale.entity';
@Entity({ name: 'sale_payments' })
@Check(
  'ck_cash_payment',
  '"amount_minor" >= 0 AND "received_minor" >= "amount_minor" AND "received_minor" <= 9007199254740991 AND "change_minor" = "received_minor" - "amount_minor"',
)
export class SalePaymentEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', { name: 'payment_id' }) id: string;
  @Column('uuid', { name: 'sale_id', unique: true }) saleId: string;
  @OneToOne(() => SaleEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'sale_id' })
  sale: SaleEntity;
  @Column({ type: 'varchar', default: 'cash' }) method: string;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column({ name: 'amount_minor', type: 'bigint' }) amountMinor: string;
  @Column({ name: 'received_minor', type: 'bigint' }) receivedMinor: string;
  @Column({ name: 'change_minor', type: 'bigint' }) changeMinor: string;
}
