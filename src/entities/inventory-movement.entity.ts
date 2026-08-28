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
@Index('ix_inventory_movements_item_created', [
  'inventoryItemId',
  'createdAtLocal',
])
@Check('ck_inventory_movements_non_zero', '"quantity_delta_atomic" <> 0')
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

  @Column({ type: 'varchar', length: 500 })
  reason: string;

  @Column({ name: 'created_at_local', type: 'timestamptz', precision: 3 })
  createdAtLocal: Date;

  @Column({ name: 'server_sequence', type: 'bigint', nullable: true })
  serverSequence: string | null;
}
