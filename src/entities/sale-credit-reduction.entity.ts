import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { SaleAdjustmentEntity } from './sale-adjustment.entity';
import { CreditSaleEntity } from './credit-sale.entity';
/** Reducción inmutable del cargo; no modifica deuda ni abonos originales. */
@Entity('sale_credit_reductions')
@Index('ix_sale_reductions_credit', ['creditId'])
@Check(
  'sale_credit_reductions_amount_minor_check',
  'amount_minor BETWEEN 1 AND 9007199254740991',
)
export class SaleCreditReductionEntity {
  @PrimaryColumn('uuid', { name: 'operation_id' }) operationId: string;
  @ManyToOne(() => SaleAdjustmentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'operation_id',
    foreignKeyConstraintName: 'sale_credit_reductions_operation_id_fkey',
  })
  operation: SaleAdjustmentEntity;
  @Column('uuid', { name: 'credit_id' }) creditId: string;
  @ManyToOne(() => CreditSaleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'credit_id',
    foreignKeyConstraintName: 'sale_credit_reductions_credit_id_fkey',
  })
  credit: CreditSaleEntity;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
}
