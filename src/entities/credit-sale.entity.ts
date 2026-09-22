import { Index } from 'typeorm';
import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
import { SaleEntity } from './sale.entity';
import { ClienteEntity } from './cliente.entity';

/** Importe original inmutable de la venta financiada, en MXN. */
@Index('ix_credit_sales_customer', ['clienteId', 'occurredAtMs', 'id'])
@Entity({ name: 'credit_sales' })
@Check(
  'ck_credit_amount',
  'amount_minor > 0 AND amount_minor <= 9007199254740991',
)
export class CreditSaleEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid', { name: 'sale_id', unique: true }) saleId: string;
  @OneToOne(() => SaleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sale_id' })
  sale: SaleEntity;
  @Column('uuid', { name: 'cliente_id' }) clienteId: string;
  @ManyToOne(() => ClienteEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cliente_id' })
  cliente: ClienteEntity;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
  @Column('bigint', { name: 'occurred_at_ms' }) occurredAtMs: string;
}
