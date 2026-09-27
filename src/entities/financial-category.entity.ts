import {
  Check,
  Column,
  Entity,
  PrimaryColumn,
} from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';

/**
 * Categoría financiera de ingresos/gastos adicionales, independiente de las
 * categorías de productos. `active` (SyncProjectionEntity) no es funcional en
 * esta primera versión: es convención de proyección y permanece true; no hay
 * edición/eliminación en esta entrega.
 */
@Entity({ name: 'financial_categories' })
@Check(
  'ck_financial_categories_name',
  'char_length(name) BETWEEN 1 AND 100',
)
@Check('ck_financial_categories_direction', "direction IN ('in', 'out')")
@Check(
  'ck_financial_categories_nature',
  "nature IN ('operating', 'capital', 'asset_purchase', 'inventory_purchase', 'financing')",
)
@Check(
  'ck_financial_categories_nature_direction',
  "NOT (direction = 'in' AND nature IN ('asset_purchase', 'inventory_purchase'))",
)
export class FinancialCategoryEntity extends SyncProjectionEntity {
  /** UUID v4 generado por el dispositivo; clave global del agregado. */
  @PrimaryColumn('uuid')
  id: string;

  /** Nombre visible, normalizado NFKC+trim con 1..100 code points. Sin unicidad. */
  @Column({ type: 'varchar', length: 100 })
  name: string;

  /** Dirección inmutable desde el alta: 'in' (ingreso) u 'out' (gasto). */
  @Column('text')
  direction: string;

  /** Naturaleza/clasificación inmutable desde el alta; no se infiere del nombre. */
  @Column('text')
  nature: string;
}