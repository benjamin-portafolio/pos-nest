import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { CategoryEntity } from './category.entity';
import { UnitEntity } from './unit.entity';
import { SyncProjectionEntity } from './sync-projection.entity';
import { SaleMode } from '../enums/sale-mode.enum';

@Entity({ name: 'products' })
@Index('ix_products_active_name', ['active', 'name', 'id'])
@Index('ix_products_category', ['categoryId'])
@Index('ix_products_sale_unit', ['saleUnitId'])
@Check('ck_products_sale_mode', `"sale_mode" IN ('unit', 'measured')`)
@Check(
  'ck_products_sale_configuration',
  `(
    ("sale_mode" = 'unit' AND "sale_unit_id" IS NULL AND
      "price_reference_quantity_atomic" IS NULL) OR
    ("sale_mode" = 'measured' AND "sale_unit_id" IS NOT NULL AND
      "price_reference_quantity_atomic" > 0)
  )`,
)
export class ProductEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', {
    name: 'product_id',
    comment: 'UUID del producto generado por el dispositivo.',
  })
  id: string;

  @Column({
    name: 'name',
    type: 'varchar',
    length: 160,
    comment: 'Nombre comercial visible del articulo.',
  })
  name: string;

  @Column('uuid', {
    name: 'category_id',
    nullable: true,
    comment: 'Categoria opcional; null representa Sin categoria.',
  })
  categoryId: string | null;

  @ManyToOne(() => CategoryEntity, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'category_id' })
  category: CategoryEntity | null;

  @Column({
    name: 'sale_mode',
    type: 'varchar',
    length: 16,
    default: SaleMode.UNIT,
  })
  saleMode: SaleMode;

  @Column('uuid', { name: 'sale_unit_id', nullable: true })
  saleUnitId: string | null;

  @ManyToOne(() => UnitEntity, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'sale_unit_id' })
  saleUnit: UnitEntity | null;

  @Column('bigint', {
    name: 'price_reference_quantity_atomic',
    nullable: true,
  })
  priceReferenceQuantityAtomic: string | null;
}
