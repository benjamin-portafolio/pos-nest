import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';

@Entity({ name: 'categories' })
@Index('idx_categories_sort_order', ['sortOrder'])
export class CategoryEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', {
    name: 'category_id',
    comment: 'UUID de la categoría generado por el dispositivo.',
  })
  id: string;

  @Column({
    name: 'name',
    type: 'varchar',
    length: 160,
    comment:
      'Nombre visible de la categoría; no tiene restricción de unicidad.',
  })
  name: string;

  @Column({
    name: 'color_key',
    type: 'varchar',
    length: 40,
    default: 'neutral',
    comment: 'Clave estable de la paleta controlada de categorías.',
  })
  colorKey: string;

  @Column({
    name: 'sort_order',
    type: 'integer',
    comment: 'Posición consecutiva de la categoría, comenzando en cero.',
  })
  sortOrder: number;
}
