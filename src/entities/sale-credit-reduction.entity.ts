import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { SaleAdjustmentEntity } from './sale-adjustment.entity';
import { CreditSaleEntity } from './credit-sale.entity';
/** Reducción inmutable del cargo; no modifica deuda ni abonos originales. */
@Entity('sale_credit_reductions')
@Check(
  'ck_sale_credit_reduction_amount',
  'amount_minor BETWEEN 1 AND 9007199254740991',
)
export class SaleCreditReductionEntity {
  @PrimaryColumn('uuid', { name: 'operation_id' }) operationId: string;
  @ManyToOne(() => SaleAdjustmentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'operation_id' })
  operation: SaleAdjustmentEntity;
  @Column('uuid', { name: 'credit_id' }) creditId: string;
  @ManyToOne(() => CreditSaleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'credit_id' })
  credit: CreditSaleEntity;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
}
