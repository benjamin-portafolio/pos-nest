import { Check, Column, Entity, PrimaryColumn } from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';

/** Catálogo con trazabilidad equivalente a CommonFields. No hay bajas ni unicidad de nombre. */
@Entity({ name: 'suppliers' })
@Check('ck_suppliers_name', "length(btrim(name, E' \t\n\r')) > 0")
export class SupplierEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', { name: 'supplier_id' })
  id: string;
  @Column({ type: 'text', comment: 'Nombre obligatorio recortado.' })
  name: string;
  @Column({
    type: 'text',
    nullable: true,
    comment: 'Teléfono como texto; vacío se normaliza a null.',
  })
  phone: string | null;
  @Column({
    type: 'text',
    nullable: true,
    comment: 'Notas opcionales recortadas.',
  })
  notes: string | null;
}
