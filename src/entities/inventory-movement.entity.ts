import { SaleItemEntity } from './sale-item.entity';
import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { InventoryItemEntity } from './inventory-item.entity';

@Entity({ name: 'inventory_movements' })
@Index('ux_sale_consumption', ['saleItemId', 'inventoryItemId'], {
  unique: true,
  where: "movement_type = 'sale_consumption'",
})
@Index('ix_movements_event', ['eventId'])
@Check(
  'ck_sale_consumption',
  "movement_type <> 'sale_consumption' OR (sale_item_id IS NOT NULL AND quantity_delta_atomic < 0 AND total_cost_minor IS NULL)",
)
@Index('ix_inventory_movements_item_created', [
  'inventoryItemId',
  'createdAtLocal',
])
@Check('ck_inventory_movements_non_zero', '"quantity_delta_atomic" <> 0')
@Check(
  'ck_inventory_movements_reason_shape',
  '"reason" IS NULL OR ("reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 500)',
)
@Check(
  'ck_inventory_movements_manual_reason',
  '"movement_type" <> \'manual_adjustment\' OR "reason" IS NOT NULL',
)
@Check(
  'ck_inventory_movements_positive_entries',
  '"movement_type" NOT IN (\'initial_balance\', \'stock_receipt\') OR "quantity_delta_atomic" > 0',
)
@Check(
  'ck_inventory_movements_reversal_reference',
  '("movement_type" = \'reversal\') = ("reversal_of_movement_id" IS NOT NULL)',
)
@Check(
  'ck_inventory_movements_no_self_reversal',
  '"reversal_of_movement_id" IS NULL OR "reversal_of_movement_id" <> "movement_id"',
)
export class InventoryMovementEntity {
  @PrimaryColumn('uuid', { name: 'movement_id' })
  movementId: string;

  @Column('uuid', { name: 'inventory_item_id' })
  inventoryItemId: string;

  @ManyToOne(() => InventoryItemEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'inventory_item_id' })
  inventoryItem: InventoryItemEntity;

  @Column('uuid', { name: 'sale_item_id', nullable: true })
  saleItemId: string | null;

  @ManyToOne(() => SaleItemEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sale_item_id' })
  saleItem: SaleItemEntity | null;

  @Column('uuid', { name: 'event_id' })
  eventId: string;

  @Column('uuid', { name: 'reversal_of_movement_id', nullable: true })
  reversalOfMovementId: string | null;

  @ManyToOne(() => InventoryMovementEntity, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'reversal_of_movement_id' })
  reversalOfMovement: InventoryMovementEntity | null;

  @Column({ name: 'movement_type', type: 'varchar', length: 40 })
  movementType: string;

  @Column({ name: 'quantity_delta_atomic', type: 'bigint' })
  quantityDeltaAtomic: string;

  @Column({ name: 'total_cost_minor', type: 'bigint', nullable: true })
  totalCostMinor: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ name: 'created_at_local', type: 'timestamptz', precision: 3 })
  createdAtLocal: Date;

  @Column({ name: 'server_sequence', type: 'bigint', nullable: true })
  serverSequence: string | null;
}
