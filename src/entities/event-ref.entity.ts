import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'event_refs' })
@Index('idx_event_refs_event_id', ['eventId'])
@Index('idx_event_refs_ref_lookup', ['refType', 'refId'])
@Index('idx_event_refs_server_sequence', ['serverSequence'])
export class EventRefEntity {
  @PrimaryColumn('uuid', {
    name: 'event_ref_id',
    comment: 'UUID unico de la referencia del evento.',
  })
  eventRefId: string;

  @Column('uuid', {
    name: 'event_id',
    comment: 'Evento relacionado con esta referencia.',
  })
  eventId: string;

  @Column({
    name: 'ref_type',
    type: 'varchar',
    length: 80,
    comment: "Tipo de referencia, por ejemplo 'espacio'.",
  })
  refType: string;

  @Column({
    name: 'ref_id',
    type: 'text',
    comment: 'Identificador de la entidad o clave de negocio referenciada.',
  })
  refId: string;

  @Column({
    name: 'relationship',
    type: 'varchar',
    length: 80,
    comment: "Relacion con el evento, por ejemplo 'affects'.",
  })
  relationship: string;

  @Column({
    name: 'server_sequence',
    type: 'bigint',
    nullable: true,
    comment: 'Secuencia de servidor del evento relacionado.',
  })
  serverSequence: string | null;

  @Column({
    name: 'source',
    type: 'varchar',
    length: 40,
    comment: "Origen de la referencia, por ejemplo 'server'.",
  })
  source: string;
}
