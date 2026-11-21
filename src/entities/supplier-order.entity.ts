import { SupplierEntity } from './supplier.entity';
import {
  Check,
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
/** Pedido con trazabilidad propia; sus partidas comparten la base del agregado. */
@Entity({ name: 'supplier_orders' })
@Check(
  'ck_supplier_orders_0',
  "status IN ('draft','confirmed','partial','received','closed','cancelled')",
)
@Check('ck_supplier_orders_1', 'length(currency) = 3')
@Check(
  'ck_supplier_orders_2',
  'length(supplier_name_snapshot) BETWEEN 1 AND 160',
)
@Check(
  'ck_supplier_orders_3',
  'supplier_phone_snapshot IS NULL OR length(supplier_phone_snapshot) <= 80',
)
@Check('ck_supplier_orders_4', 'notes IS NULL OR length(notes) <= 1000')
@Check(
  'ck_supplier_orders_occurred_at_ms',
  'occurred_at_ms IS NULL OR occurred_at_ms BETWEEN 1 AND 9007199254740991',
)
@Check(
  'ck_supplier_orders_total_minor',
  'total_minor IS NULL OR total_minor BETWEEN 0 AND 9007199254740991',
)
@Index('ix_supplier_orders_lookup', ['supplierId', 'status', 'occurredAtMs'])
@ForeignKey(() => SupplierEntity, ['supplierId'], ['id'], {
  onDelete: 'RESTRICT',
})
export class SupplierOrderEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid')
  id: string;
  @Column({ name: 'supplier_id', type: 'uuid' })
  supplierId: string;
  @Column({ name: 'status', type: 'text' })
  status: string;
  @Column({ name: 'occurred_at_ms', type: 'bigint' })
  occurredAtMs: string;
  @Column({ name: 'currency', type: 'text' })
  currency: string;
  @Column({ name: 'supplier_name_snapshot', type: 'text' })
  supplierNameSnapshot: string;
  @Column({ name: 'supplier_phone_snapshot', type: 'text', nullable: true })
  supplierPhoneSnapshot: string | null;
  @Column({ name: 'notes', type: 'text', nullable: true })
  notes: string | null;
  @Column({ name: 'total_minor', type: 'bigint', nullable: true })
  totalMinor: string | null;
}
