import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { ProductVariantEntity } from './product-variant.entity';
import { SupplierEntity } from './supplier.entity';

/** Hijo reemplazable del agregado producto. Sin versión ni evento independiente, como recipe_components. */
@Entity({ name: 'variant_suppliers' })
@Check(
  'ck_variant_suppliers_price',
  '"quoted_price_minor" BETWEEN 0 AND 9007199254740991',
)
@Check(
  'ck_variant_suppliers_date',
  '"quoted_at_ms" BETWEEN 1 AND 9007199254740991',
)
export class VariantSupplierEntity {
  @PrimaryColumn('uuid', {
    name: 'variant_id',
    primaryKeyConstraintName: 'pk_variant_suppliers',
  })
  variantId: string;
  @ManyToOne(() => ProductVariantEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'variant_id',
    foreignKeyConstraintName: 'fk_variant_suppliers_variant',
  })
  variant: ProductVariantEntity;
  @PrimaryColumn('uuid', {
    name: 'supplier_id',
    primaryKeyConstraintName: 'pk_variant_suppliers',
  })
  supplierId: string;
  @ManyToOne(() => SupplierEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'supplier_id',
    foreignKeyConstraintName: 'fk_variant_suppliers_supplier',
  })
  supplier: SupplierEntity;
  @Column({
    name: 'quoted_price_minor',
    type: 'bigint',
    comment: 'Precio informado en unidad menor; cero explícito.',
  })
  quotedPriceMinor: string;
  @Column({
    name: 'quoted_at_ms',
    type: 'bigint',
    comment:
      'Instante UTC en milisegundos; sin conversión a Date ni arbitraje por reloj.',
  })
  quotedAtMs: string;
}
