import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { SaleAdjustmentEntity } from './sale-adjustment.entity';
import { SaleItemEntity } from './sale-item.entity';
/** Libro de líneas sin ciclo de vida ni versión propios. */
@Entity('sale_adjustment_lines')
@Check(
  'ck_adjustment_line_quantity',
  'quantity_atomic BETWEEN 1 AND 9007199254740991',
)
@Check(
  'ck_adjustment_line_amount',
  'amount_minor BETWEEN 0 AND 9007199254740991',
)
@Check(
  'ck_adjustment_line_cost',
  'recovered_cost_minor IS NULL OR recovered_cost_minor BETWEEN 0 AND 9007199254740991',
)
@Check(
  'ck_adjustment_line_destination',
  "destination IN ('void','restock','not_restockable','untracked')",
)
export class SaleAdjustmentLineEntity {
  @PrimaryColumn('uuid', { name: 'operation_id' }) operationId: string;
  @ManyToOne(() => SaleAdjustmentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'operation_id' })
  operation: SaleAdjustmentEntity;
  @PrimaryColumn('uuid', { name: 'sale_item_id' }) saleItemId: string;
  @ManyToOne(() => SaleItemEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sale_item_id' })
  saleItem: SaleItemEntity;
  @Column('bigint', { name: 'quantity_atomic' }) quantityAtomic: string;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
  @Column('bigint', { name: 'recovered_cost_minor', nullable: true })
  recoveredCostMinor: string | null;
  @Column('text') destination: string;
  @Column('text', { nullable: true }) reason: string | null;
}
