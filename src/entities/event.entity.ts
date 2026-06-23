import {
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EventSyncStatus } from '../enums/event-sync-status.enum';

@Entity({ name: 'events' })
@Index('idx_events_aggregate', ['aggregateType', 'aggregateId'])
@Index(
  'idx_events_device_local_sequence_unique',
  ['deviceId', 'localSequence'],
  {
    unique: true,
  },
)
@Index('idx_events_event_type', ['eventType'])
@Index('idx_events_sync_status_sequence', ['syncStatus', 'serverSequence'])
export class EventEntity {
  @PrimaryColumn('uuid', {
    name: 'event_id',
    comment: 'UUID global generado por el dispositivo movil.',
  })
  eventId: string;

  @Column({
    name: 'aggregate_type',
    type: 'varchar',
    length: 80,
    comment: "Tipo de agregado afectado, por ejemplo 'espacio'.",
  })
  aggregateType: string;

  @Column('uuid', {
    name: 'aggregate_id',
    comment: 'UUID del agregado afectado por el evento.',
  })
  aggregateId: string;

  @Column({
    name: 'event_type',
    type: 'varchar',
    length: 120,
    comment: "Tipo de evento, por ejemplo 'espacio_creado'.",
  })
  eventType: string;

  @Column({
    name: 'device_id',
    type: 'varchar',
    length: 120,
    comment: 'Identificador del dispositivo que genero el evento.',
  })
  deviceId: string;

  @Column({
    name: 'user_id',
    type: 'varchar',
    length: 120,
    comment: 'Identificador del usuario que ejecuto la accion.',
  })
  userId: string;

  @Column({
    name: 'local_sequence',
    type: 'integer',
    nullable: true,
    comment: 'Secuencia local asignada por el dispositivo.',
  })
  localSequence: number | null;

  @Column({
    name: 'server_sequence',
    type: 'bigint',
    unique: true,
    comment: 'Secuencia global asignada por el servidor al recibir el evento.',
  })
  @Generated('increment')
  serverSequence: string;

  @Column({
    name: 'base_server_sequence',
    type: 'bigint',
    nullable: true,
    comment:
      'Cursor de servidor conocido por el dispositivo al crear el evento.',
  })
  baseServerSequence: string | null;

  @Column({
    name: 'base_version',
    type: 'integer',
    nullable: true,
    comment: 'Version del agregado conocida por el dispositivo.',
  })
  baseVersion: number | null;

  @Column({
    name: 'created_at_local',
    type: 'timestamptz',
    precision: 3,
    comment: 'Fecha y hora local en que el dispositivo genero el evento.',
  })
  createdAtLocal: Date;

  @CreateDateColumn({
    name: 'created_at_server',
    type: 'timestamptz',
    precision: 3,
    comment: 'Fecha y hora en que el servidor recibio el evento.',
  })
  createdAtServer: Date;

  @Column({
    name: 'payload',
    type: 'jsonb',
    comment: 'Datos especificos del evento.',
  })
  payload: Record<string, unknown>;

  @Column({
    name: 'sync_status',
    type: 'enum',
    enum: EventSyncStatus,
    enumName: 'event_sync_status',
    default: EventSyncStatus.PENDING,
    comment: 'Estado de procesamiento del evento en el servidor.',
  })
  syncStatus: EventSyncStatus;

  @Column({
    name: 'rejection_reason',
    type: 'text',
    nullable: true,
    comment: 'Motivo de rechazo o conflicto cuando aplique.',
  })
  rejectionReason: string | null;

  @UpdateDateColumn({
    name: 'updated_at_server',
    type: 'timestamptz',
    precision: 3,
    comment: 'Fecha y hora de la ultima actualizacion del evento en servidor.',
  })
  updatedAtServer: Date;
}
