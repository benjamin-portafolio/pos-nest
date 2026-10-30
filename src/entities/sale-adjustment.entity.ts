import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
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
@Unique('ux_sale_adjustment_revision', ['saleId', 'revision'])
@Index('ux_sale_adjustment_void', ['saleId'], {
  unique: true,
  where: "kind = 'void'",
})
@Index('ix_sale_adjustment_date', ['businessDate'])
@Check(
  'sale_adjustments_total_minor_check',
  'total_minor BETWEEN 0 AND 9007199254740991',
)
@Check('sale_adjustments_revision_check', 'revision > 0')
@Check('sale_adjustments_kind_check', "kind IN ('void','return')")
@Check(
  'sale_adjustments_reason_check',
  'reason=btrim(reason) AND length(reason) BETWEEN 1 AND 500',
)
@Check('sale_adjustments_occurred_at_ms_check', 'occurred_at_ms>0')
@Check(
  'sale_adjustments_utc_offset_minutes_check',
  'abs(utc_offset_minutes)<=840',
)
@Check('sale_adjustments_currency_check', "currency='MXN'")
@Check(
  'sale_adjustments_method_check',
  "method IN ('cash','transfer','credit')",
)
@Check(
  'sale_adjustments_settlement_action_check',
  "settlement_action IN ('refund_completed','unreceived_correction','credit_reduction','no_money')",
)
export class SaleAdjustmentEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid', { name: 'event_id', unique: true }) eventId: string;
  @ManyToOne(() => EventEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'sale_adjustments_event_id_fkey',
  })
  event: EventEntity;
  @Column('uuid', { name: 'sale_id' }) saleId: string;
  @ManyToOne(() => SaleEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'sale_id',
    foreignKeyConstraintName: 'sale_adjustments_sale_id_fkey',
  })
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
  @JoinColumn({
    name: 'payment_id',
    foreignKeyConstraintName: 'sale_adjustments_payment_id_fkey',
  })
  payment: SalePaymentEntity | null;
  @Column('uuid', { name: 'cliente_id', nullable: true }) clienteId:
    | string
    | null;
  @ManyToOne(() => ClienteEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'cliente_id',
    foreignKeyConstraintName: 'sale_adjustments_cliente_id_fkey',
  })
  cliente: ClienteEntity | null;
}
