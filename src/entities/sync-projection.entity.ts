import { Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export abstract class SyncProjectionEntity {
  @Column({
    name: 'active',
    type: 'boolean',
    default: true,
    comment: 'Indica si la proyeccion esta activa.',
  })
  active: boolean;

  @Column({
    name: 'version',
    type: 'integer',
    default: 1,
    comment: 'Version de la proyeccion para concurrencia optimista.',
  })
  version: number;

  @Column('uuid', {
    name: 'created_event_id',
    nullable: true,
    comment: 'Evento que creo la proyeccion.',
  })
  createdEventId: string | null;

  @Column('uuid', {
    name: 'last_event_id',
    nullable: true,
    comment: 'Ultimo evento aplicado a la proyeccion.',
  })
  lastEventId: string | null;

  @Column({
    name: 'last_server_sequence',
    type: 'bigint',
    nullable: true,
    comment: 'Ultima secuencia de servidor aplicada a la proyeccion.',
  })
  lastServerSequence: string | null;

  @CreateDateColumn({
    name: 'created_at_server',
    type: 'timestamptz',
    precision: 3,
    comment: 'Fecha en que el servidor creo la proyeccion.',
  })
  createdAtServer: Date;

  @UpdateDateColumn({
    name: 'updated_at_server',
    type: 'timestamptz',
    precision: 3,
    comment: 'Fecha de ultima actualizacion de la proyeccion.',
  })
  updatedAtServer: Date;
}
