import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
import { SaleEntity } from './sale.entity';
import { ProductVariantEntity } from './product-variant.entity';
import type { ConfirmedSaleLine } from '../sync/payloads/venta-confirmada.payload';
@Entity({ name: 'sale_items' })
@Index('ix_sale_items_sale', ['saleId'])
@Index('ix_sale_items_variant', ['variantId'])
export class SaleItemEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', { name: 'sale_item_id' }) id: string;
  @Column('uuid', { name: 'sale_id' }) saleId: string;
  @ManyToOne(() => SaleEntity, { onDelete: 'RESTRICT', nullable: false })
  @JoinColumn({ name: 'sale_id' })
  sale: SaleEntity;
  @Column('uuid', { name: 'variant_id' }) variantId: string;
  @ManyToOne(() => ProductVariantEntity, {
    onDelete: 'RESTRICT',
    nullable: false,
  })
  @JoinColumn({ name: 'variant_id' })
  variant: ProductVariantEntity;
  @Column({ name: 'total_minor', type: 'bigint' }) totalMinor: string;
  @Column({ name: 'sort_order', type: 'integer' }) sortOrder: number;
  // Snapshot tipado completo: precio, medida y configuración histórica de consumo.
  @Column({ type: 'jsonb' }) snapshot: ConfirmedSaleLine;
}
