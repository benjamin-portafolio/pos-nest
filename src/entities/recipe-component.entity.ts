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
import { ProductVariantEntity } from './product-variant.entity';

@Entity({ name: 'recipe_components' })
@Index('ix_recipe_components_inventory_item', ['inventoryItemId'])
@Check(
  'ck_recipe_components_quantity_atomic',
  '"quantity_atomic" > 0 AND "quantity_atomic" <= 9007199254740991',
)
export class RecipeComponentEntity {
  @PrimaryColumn('uuid', {
    name: 'variant_id',
    primaryKeyConstraintName: 'pk_recipe_components',
  })
  variantId: string;

  @ManyToOne(() => ProductVariantEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'variant_id',
    foreignKeyConstraintName: 'fk_recipe_components_variant',
  })
  variant: ProductVariantEntity;

  @PrimaryColumn('uuid', {
    name: 'inventory_item_id',
    primaryKeyConstraintName: 'pk_recipe_components',
  })
  inventoryItemId: string;

  @ManyToOne(() => InventoryItemEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'inventory_item_id',
    foreignKeyConstraintName: 'fk_recipe_components_inventory_item',
  })
  inventoryItem: InventoryItemEntity;

  @Column({
    name: 'quantity_atomic',
    type: 'bigint',
    comment:
      'Consumo atómico por unidad vendida o por la referencia del producto medido.',
  })
  quantityAtomic: string;
}
