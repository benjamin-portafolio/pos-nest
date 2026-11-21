import { UnitEntity } from './unit.entity';
import { SupplierOrderEntity } from './supplier-order.entity';
import { ProductVariantEntity } from './product-variant.entity';
import { InventoryItemEntity } from './inventory-item.entity';
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
@Entity({ name: 'supplier_order_items' })
@Check('ck_supplier_order_items_0', "dimension IN ('count','mass','volume')")
@Check(
  'ck_supplier_order_items_1',
  'length(product_name_snapshot) BETWEEN 1 AND 160',
)
@Check(
  'ck_supplier_order_items_2',
  'variant_name_snapshot IS NULL OR length(variant_name_snapshot) <= 160',
)
@Check(
  'ck_supplier_order_items_3',
  'length(unit_code_snapshot) BETWEEN 1 AND 16',
)
@Check(
  'ck_supplier_order_items_4',
  'length(unit_symbol_snapshot) BETWEEN 1 AND 16',
)
@Check(
  'ck_supplier_order_items_5',
  "dimension <> 'count' OR (unit_atomic_factor = 1 AND reference_quantity_atomic = 1)",
)
@Check('ck_supplier_order_items_6', 'closed_quantity_atomic <= quantity_atomic')
@Check('ck_supplier_order_items_7', 'position BETWEEN 0 AND 49')
@Check(
  'ck_supplier_order_items_11',
  '(quoted_price_minor IS NULL) = (total_minor IS NULL)',
)
@Check(
  'ck_supplier_order_items_unit_atomic_factor',
  'unit_atomic_factor IS NULL OR unit_atomic_factor BETWEEN 1 AND 9007199254740991',
)
@Check(
  'ck_supplier_order_items_reference_quantity_atomic',
  'reference_quantity_atomic IS NULL OR reference_quantity_atomic BETWEEN 1 AND 9007199254740991',
)
@Check(
  'ck_supplier_order_items_quantity_atomic',
  'quantity_atomic IS NULL OR quantity_atomic BETWEEN 1 AND 9007199254740991',
)
@Check(
  'ck_supplier_order_items_quoted_price_minor',
  'quoted_price_minor IS NULL OR quoted_price_minor BETWEEN 0 AND 9007199254740991',
)
@Check(
  'ck_supplier_order_items_total_minor',
  'total_minor IS NULL OR total_minor BETWEEN 0 AND 9007199254740991',
)
@Check(
  'ck_supplier_order_items_closed_quantity_atomic',
  'closed_quantity_atomic IS NULL OR closed_quantity_atomic BETWEEN 0 AND 9007199254740991',
)
@Index('ix_supplier_order_items_lookup', ['variantId', 'orderId'])
@ForeignKey(() => SupplierOrderEntity, ['orderId'], ['id'], {
  onDelete: 'RESTRICT',
})
@ForeignKey(() => ProductVariantEntity, ['variantId'], ['id'], {
  onDelete: 'RESTRICT',
})
@ForeignKey(() => InventoryItemEntity, ['inventoryItemId'], ['id'], {
  onDelete: 'RESTRICT',
})
@ForeignKey(() => UnitEntity, ['unitId'], ['unitId'], { onDelete: 'RESTRICT' })
@Unique(['orderId', 'position'])
@Unique(['orderId', 'variantId'])
@Unique(['orderId', 'id'])
export class SupplierOrderItemEntity {
  @PrimaryColumn('uuid')
  id: string;
  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;
  @Column({ name: 'variant_id', type: 'uuid' })
  variantId: string;
  @Column({ name: 'inventory_item_id', type: 'uuid' })
  inventoryItemId: string;
  @Column({ name: 'unit_id', type: 'uuid' })
  unitId: string;
  @Column({ name: 'product_name_snapshot', type: 'text' })
  productNameSnapshot: string;
  @Column({ name: 'variant_name_snapshot', type: 'text', nullable: true })
  variantNameSnapshot: string | null;
  @Column({ name: 'dimension', type: 'text' })
  dimension: string;
  @Column({ name: 'unit_code_snapshot', type: 'text' })
  unitCodeSnapshot: string;
  @Column({ name: 'unit_symbol_snapshot', type: 'text' })
  unitSymbolSnapshot: string;
  @Column({ name: 'unit_atomic_factor', type: 'bigint' })
  unitAtomicFactor: string;
  @Column({ name: 'reference_quantity_atomic', type: 'bigint' })
  referenceQuantityAtomic: string;
  @Column({ name: 'quantity_atomic', type: 'bigint' })
  quantityAtomic: string;
  @Column({ name: 'quoted_price_minor', type: 'bigint', nullable: true })
  quotedPriceMinor: string | null;
  @Column({ name: 'total_minor', type: 'bigint', nullable: true })
  totalMinor: string | null;
  @Column({ name: 'closed_quantity_atomic', type: 'bigint', default: 0 })
  closedQuantityAtomic: string;
  @Column({ name: 'position', type: 'bigint' })
  position: string;
}
