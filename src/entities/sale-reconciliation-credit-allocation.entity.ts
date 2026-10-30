import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { ClienteEntity } from './cliente.entity';
/** Proyección FIFO derivada entre identidades reales de cargos/abonos y notas
 * independientes. No crea ventas, cargos originales ni customer_payments. */
@Entity('sale_reconciliation_credit_allocations')
@Check(
  'sale_reconciliation_credit_allocations_amount_minor_check',
  'amount_minor>0',
)
export class SaleReconciliationCreditAllocationEntity {
  @PrimaryColumn('uuid', { name: 'source_id' }) sourceId: string;
  @PrimaryColumn('uuid', { name: 'target_id' }) targetId: string;
  @Column('uuid', { name: 'cliente_id' }) clienteId: string;
  @ManyToOne(() => ClienteEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'cliente_id',
    foreignKeyConstraintName:
      'sale_reconciliation_credit_allocations_cliente_id_fkey',
  })
  cliente: ClienteEntity;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
}
