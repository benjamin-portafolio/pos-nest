import { SupplierReceiptEntity } from './supplier-receipt.entity';
import { SupplierOrderEntity } from './supplier-order.entity';
import { SupplierOrderItemEntity } from './supplier-order-item.entity';
import { InventoryMovementEntity } from './inventory-movement.entity';
import {
  Check,
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
/** Hijo sin versión propia; concurrencia gobernada por el pedido. */
@Entity({ name: 'supplier_receipt_items' })
@Check(
  'ck_supplier_receipt_items_quantity_atomic',
  'quantity_atomic IS NULL OR quantity_atomic BETWEEN 1 AND 9007199254740991',
)
@Check(
  'ck_supplier_receipt_items_actual_price_minor',
  'actual_price_minor IS NULL OR actual_price_minor BETWEEN 0 AND 9007199254740991',
)
@Check(
  'ck_supplier_receipt_items_total_minor',
  'total_minor IS NULL OR total_minor BETWEEN 0 AND 9007199254740991',
)
@Index('ix_supplier_receipt_items_lookup', ['orderItemId', 'receiptId'])
@ForeignKey(() => SupplierReceiptEntity, ['receiptId'], ['id'], {
  onDelete: 'RESTRICT',
})
@ForeignKey(() => SupplierOrderEntity, ['orderId'], ['id'], {
  onDelete: 'RESTRICT',
})
@ForeignKey(() => SupplierOrderItemEntity, ['orderItemId'], ['id'], {
  onDelete: 'RESTRICT',
})
@ForeignKey(() => InventoryMovementEntity, ['movementId'], ['movementId'], {
  onDelete: 'RESTRICT',
})
@Unique(['movementId'])
@Unique(['receiptId', 'orderItemId'])
@ForeignKey(
  () => SupplierReceiptEntity,
  ['orderId', 'receiptId'],
  ['orderId', 'id'],
  { onDelete: 'RESTRICT' },
)
@ForeignKey(
  () => SupplierOrderItemEntity,
  ['orderId', 'orderItemId'],
  ['orderId', 'id'],
  { onDelete: 'RESTRICT' },
)
export class SupplierReceiptItemEntity {
  @PrimaryColumn('uuid')
  id: string;
  @Column({ name: 'receipt_id', type: 'uuid' })
  receiptId: string;
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;
  @Column({ name: 'order_item_id', type: 'uuid' })
  orderItemId: string;
  @Column({ name: 'quantity_atomic', type: 'bigint' })
  quantityAtomic: string;
  @Column({ name: 'actual_price_minor', type: 'bigint' })
  actualPriceMinor: string;
  @Column({ name: 'total_minor', type: 'bigint' })
  totalMinor: string;
  @Column({ name: 'movement_id', type: 'uuid' })
  movementId: string;
}
