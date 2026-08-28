import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
import { UnitEntity } from './unit.entity';

@Entity({ name: 'inventory_items' })
@Index('ix_inventory_items_active_name', ['active', 'name', 'id'])
@Index('ix_inventory_items_default_unit', ['defaultUnitId'])
export class InventoryItemEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', { name: 'inventory_item_id' })
  id: string;

  @Column('uuid', { name: 'default_unit_id' })
  defaultUnitId: string;

  @ManyToOne(() => UnitEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'default_unit_id' })
  defaultUnit: UnitEntity;

  @Column({ type: 'varchar', length: 160 })
  name: string;
}
