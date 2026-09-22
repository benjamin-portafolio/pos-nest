import { Index } from 'typeorm';
import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
import { ClienteEntity } from './cliente.entity';
/** Abono real o anticipo del cliente, siempre en MXN; no es una nueva venta. */
@Index('ix_customer_payments_customer', ['clienteId', 'occurredAtMs', 'id'])
@Entity({ name: 'customer_payments' })
@Check(
  'ck_customer_payment_amount',
  'amount_minor > 0 AND amount_minor <= 9007199254740991',
)
@Check('ck_customer_payment_method', "method IN ('cash', 'transfer')")
export class CustomerPaymentEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid', { name: 'cliente_id' }) clienteId: string;
  @ManyToOne(() => ClienteEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cliente_id' })
  cliente: ClienteEntity;
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
  @Column('text') method: string;
  @Column('text', { nullable: true }) reference: string | null;
  @Column('bigint', { name: 'occurred_at_ms' }) occurredAtMs: string;
}
