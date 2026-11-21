import { SupplierOrderEntity } from './supplier-order.entity';
import {
  Check,
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
/** Documento con trazabilidad; receptor de negocio se implementa en S3/S4. */
@Entity({ name: 'supplier_receipts' })
@Check('ck_supplier_receipts_2', 'length(intent_hash) = 64')
@Check(
  'ck_supplier_receipts_occurred_at_ms',
  'occurred_at_ms IS NULL OR occurred_at_ms BETWEEN 1 AND 9007199254740991',
)
@Check(
  'ck_supplier_receipts_total_minor',
  'total_minor IS NULL OR total_minor BETWEEN 0 AND 9007199254740991',
)
@Index('ix_supplier_receipts_lookup', ['orderId', 'occurredAtMs'])
@ForeignKey(() => SupplierOrderEntity, ['orderId'], ['id'], {
  onDelete: 'RESTRICT',
})
@Unique(['eventId'])
@Unique(['orderId', 'id'])
export class SupplierReceiptEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid')
  id: string;
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;
  @Column({ name: 'event_id', type: 'uuid' })
  eventId: string;
  @Column({ name: 'intent_hash', type: 'text' })
  intentHash: string;
  @Column({ name: 'base_event_id', type: 'uuid' })
  baseEventId: string;
  @Column({ name: 'occurred_at_ms', type: 'bigint' })
  occurredAtMs: string;
  @Column({ name: 'total_minor', type: 'bigint' })
  totalMinor: string;
}
