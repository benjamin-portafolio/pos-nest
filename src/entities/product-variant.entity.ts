import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { ProductEntity } from './product.entity';
import { InventoryItemEntity } from './inventory-item.entity';
import { SyncProjectionEntity } from './sync-projection.entity';

@Entity({ name: 'product_variants' })
@Index('ux_product_variants_product_sort', ['productId', 'sortOrder'], {
  unique: true,
  where: '"active" = true',
})
@Index('ix_product_variants_product_active_sort', [
  'productId',
  'active',
  'sortOrder',
])
@Index('ux_product_variants_product_name_key', ['productId', 'nameKey'], {
  unique: true,
  where: '"active" = true AND "name_key" IS NOT NULL',
})
@Index('ux_product_variants_inventory_item', ['inventoryItemId'], {
  unique: true,
  where: '"inventory_item_id" IS NOT NULL',
})
@Check('ck_product_variants_sale_price_positive', '"sale_price_minor" > 0')
@Check(
  'ck_product_variants_standard_cost_non_negative',
  '"standard_cost_minor" IS NULL OR "standard_cost_minor" >= 0',
)
@Check(
  'ck_product_variants_name_key_coherence',
  '("name" IS NULL) = ("name_key" IS NULL)',
)
@Check('ck_product_variants_sort_order', '"sort_order" >= 0')
export class ProductVariantEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', {
    name: 'variant_id',
    comment: 'UUID de la variante generado por el dispositivo.',
  })
  id: string;

  @Column('uuid', {
    name: 'product_id',
    comment: 'Producto propietario de la variante.',
  })
  productId: string;

  @ManyToOne(() => ProductEntity, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'product_id' })
  product: ProductEntity;

  @Column({
    name: 'name',
    type: 'varchar',
    length: 160,
    nullable: true,
    comment: 'Nombre NFKC opcional de la variante.',
  })
  name: string | null;

  @Column({
    name: 'name_key',
    type: 'varchar',
    length: 320,
    nullable: true,
    comment: 'Nombre NFKC en minúsculas para unicidad por producto.',
  })
  nameKey: string | null;

  @Column({
    name: 'sale_price_minor',
    type: 'bigint',
    comment: 'Precio entero expresado en la unidad monetaria menor.',
  })
  salePriceMinor: string;

  @Column({
    name: 'standard_cost_minor',
    type: 'bigint',
    nullable: true,
    comment:
      'Costo estándar opcional; null es desconocido y cero es costo conocido.',
  })
  standardCostMinor: string | null;

  @Column('uuid', {
    name: 'inventory_item_id',
    nullable: true,
    comment:
      'Recurso cuyo saldo sigue directamente esta variante; null desactiva el seguimiento.',
  })
  inventoryItemId: string | null;

  @ManyToOne(() => InventoryItemEntity, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'inventory_item_id' })
  inventoryItem: InventoryItemEntity | null;

  @Column({
    name: 'is_default',
    type: 'boolean',
    comment: 'La variante inicial predeterminada del producto.',
  })
  isDefault: boolean;

  @Column({
    name: 'sort_order',
    type: 'integer',
    comment: 'Posicion dentro del producto; inicia en cero.',
  })
  sortOrder: number;
}
