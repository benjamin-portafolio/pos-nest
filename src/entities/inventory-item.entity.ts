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
@Index('ix_inventory_items_origin_variant', ['originVariantId'])
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

  /**
   * Variante que originó este recurso, escrita solo por
   * `recurso_inventario_creado`. Renombrar el recurso o mover su stock no la
   * modifica.
   *
   * Es una identidad de procedencia y **no** una FK: el evento de recurso se
   * aplica antes de que exista la variante, de modo que declarar la referencia
   * invertaría el orden causal recurso → producto. El formato UUID v4 se valida
   * en el contrato del evento.
   *
   * El índice es deliberadamente no único: pueden existir recursos históricos
   * o creaciones concurrentes con el mismo origen, y la unicidad normativa
   * sigue siendo la del vínculo directo de `product_variants`. Null significa
   * procedencia desconocida (recursos independientes y eventos legados) y no
   * autoriza ningún descarte.
   */
  @Column({
    name: 'origin_variant_id',
    type: 'uuid',
    nullable: true,
    comment:
      'Variante que originó el recurso; identidad, no FK. Null = desconocido.',
  })
  originVariantId: string | null;
}
