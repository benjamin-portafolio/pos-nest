import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { InventoryItemEntity } from './inventory-item.entity';

@Entity({ name: 'inventory_balances' })
export class InventoryBalanceEntity {
  @PrimaryColumn('uuid', { name: 'inventory_item_id' })
  inventoryItemId: string;

  @OneToOne(() => InventoryItemEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inventory_item_id' })
  inventoryItem: InventoryItemEntity;

  @Column({ name: 'quantity_on_hand_atomic', type: 'bigint' })
  quantityOnHandAtomic: string;

  @Column({ name: 'quantity_available_atomic', type: 'bigint' })
  quantityAvailableAtomic: string;

  @Column({ type: 'integer', default: 1 })
  version: number;

  @Column('uuid', { name: 'last_event_id' })
  lastEventId: string;

  @Column({ name: 'last_server_sequence', type: 'bigint', nullable: true })
  lastServerSequence: string | null;
}
