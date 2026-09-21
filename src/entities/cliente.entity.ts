import { Check, Column, Entity, PrimaryColumn } from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';

/** Proyección oficial del alta de clientes. Nombre y teléfono no son claves únicas. */
@Entity({ name: 'clientes' })
@Check('ck_clientes_nombre', 'length(trim(nombre)) > 0')
export class ClienteEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid', {
    name: 'cliente_id',
    comment: 'UUID generado por el dispositivo.',
  })
  id: string;

  @Column({ type: 'text', comment: 'Nombre obligatorio del cliente.' })
  nombre: string;

  @Column({
    type: 'text',
    nullable: true,
    comment: 'Teléfono opcional, conservando prefijos y ceros iniciales.',
  })
  telefono: string | null;
}
