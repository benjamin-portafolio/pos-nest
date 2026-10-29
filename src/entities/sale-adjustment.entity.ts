import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
import { SaleEntity } from './sale.entity';
import { EventEntity } from './event.entity';
import { SalePaymentEntity } from './sale-payment.entity';
import { ClienteEntity } from './cliente.entity';
/** Documento compensatorio inmutable; la venta original permanece intacta. */
@Entity('sale_adjustments')
@Check(
  'ck_sale_adjustment_settlement',
  "(method='credit' AND payment_id IS NULL AND cliente_id IS NOT NULL) OR (method IN ('cash','transfer') AND payment_id IS NOT NULL)",
)
@Index('ux_sale_adjustment_revision', ['saleId', 'revision'], { unique: true })
@Index('ux_sale_adjustment_void', ['saleId'], {
  unique: true,
  where: "kind = 'void'",
})
@Index('ix_sale_adjustment_date', ['businessDate'])
@Check(
  'ck_sale_adjustment_amount',
  'total_minor BETWEEN 0 AND 9007199254740991',
)
@Check('ck_sale_adjustment_revision', 'revision > 0')
@Check('ck_sale_adjustment_kind', "kind IN ('void','return')")
export class SaleAdjustmentEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid', { name: 'event_id', unique: true }) eventId: string;
  @ManyToOne(() => EventEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'event_id' })
  event: EventEntity;
  @Column('uuid', { name: 'sale_id' }) saleId: string;
  @ManyToOne(() => SaleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sale_id' })
  sale: SaleEntity;
  @Column('integer') revision: number;
  @Column('text') kind: string;
  @Column('text') reason: string;
  @Column('bigint', { name: 'total_minor' }) totalMinor: string;
  @Column('bigint', { name: 'occurred_at_ms' }) occurredAtMs: string;
  @Column('integer', { name: 'utc_offset_minutes' }) utcOffsetMinutes: number;
  @Column('text', { name: 'business_date' }) businessDate: string;
  @Column('text') currency: string;
  @Column('text') method: string;
  @Column('text', { name: 'settlement_action' }) settlementAction: string;
  @Column('text', { nullable: true }) reference: string | null;
  @Column('uuid', { name: 'payment_id', nullable: true }) paymentId:
    | string
    | null;
  @ManyToOne(() => SalePaymentEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'payment_id' })
  payment: SalePaymentEntity | null;
  @Column('uuid', { name: 'cliente_id', nullable: true }) clienteId:
    | string
    | null;
  @ManyToOne(() => ClienteEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'cliente_id' })
  cliente: ClienteEntity | null;
}
