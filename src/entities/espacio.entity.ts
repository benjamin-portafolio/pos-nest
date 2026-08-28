import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';

@Entity({ name: 'espacios' })
@Index('idx_espacios_identificacion_unique', ['identificacion'], {
  unique: true,
  where: '"identificacion" IS NOT NULL',
})
export class EspacioEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', {
    name: 'espacio_id',
    comment: 'UUID del espacio generado por el dispositivo.',
  })
  id: string;

  @Column({
    name: 'nombre',
    type: 'varchar',
    length: 160,
    comment: 'Nombre visible del espacio.',
  })
  nombre: string;

  @Column({
    name: 'identificacion',
    type: 'varchar',
    length: 160,
    nullable: true,
    comment: 'Clave de negocio opcional para identificar el espacio.',
  })
  identificacion: string | null;

  @Column({
    name: 'visibilidad',
    type: 'integer',
    comment: 'Valor de visibilidad usado por la app movil.',
  })
  visibilidad: number;
}
