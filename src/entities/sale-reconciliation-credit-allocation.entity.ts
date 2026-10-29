import { Column, Entity, PrimaryColumn } from 'typeorm';
/** Proyección FIFO derivada entre identidades reales de cargos/abonos y notas
 * independientes. No crea ventas, cargos originales ni customer_payments. */
@Entity('sale_reconciliation_credit_allocations')
export class SaleReconciliationCreditAllocationEntity {
  @PrimaryColumn('uuid', { name: 'source_id' }) sourceId: string;
  @PrimaryColumn('uuid', { name: 'target_id' }) targetId: string;
  @Column('uuid', { name: 'cliente_id' }) clienteId: string;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
}
