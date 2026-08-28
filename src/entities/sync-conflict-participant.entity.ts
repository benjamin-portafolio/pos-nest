import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { SyncConflictParticipantRole } from '../enums/sync-conflict-participant-role.enum';

@Entity({ name: 'sync_conflict_participants' })
@Index(
  'ux_sync_conflict_participants_conflict_event',
  ['conflictId', 'eventId'],
  {
    unique: true,
  },
)
@Index('ix_sync_conflict_participants_event', ['eventId'])
@Index('ix_sync_conflict_participants_aggregate', [
  'aggregateType',
  'aggregateId',
])
export class SyncConflictParticipantEntity {
  @PrimaryGeneratedColumn('uuid', {
    name: 'participant_id',
    comment: 'UUID del participante dentro del conflicto.',
  })
  participantId: string;

  @Column('uuid', {
    name: 'conflict_id',
    comment: 'Conflicto al que pertenece el participante.',
  })
  conflictId: string;

  @Column('uuid', {
    name: 'event_id',
    comment: 'Evento participante, ganador o contendiente.',
  })
  eventId: string;

  @Column({
    name: 'participant_role',
    type: 'enum',
    enum: SyncConflictParticipantRole,
    enumName: 'sync_conflict_participant_role',
    comment: 'Rol del evento dentro del conflicto.',
  })
  participantRole: SyncConflictParticipantRole;

  @Column({
    name: 'aggregate_type',
    type: 'varchar',
    length: 80,
    comment: 'Tipo de agregado del evento participante.',
  })
  aggregateType: string;

  @Column('uuid', {
    name: 'aggregate_id',
    comment: 'Agregado del evento participante.',
  })
  aggregateId: string;

  @Column({
    name: 'event_type',
    type: 'varchar',
    length: 120,
    comment: 'Tipo del evento participante.',
  })
  eventType: string;

  @Column({
    name: 'sync_status',
    type: 'varchar',
    length: 40,
    comment: 'Estado efectivo del evento participante.',
  })
  syncStatus: string;

  @Column({
    name: 'server_sequence',
    type: 'bigint',
    nullable: true,
    comment: 'Secuencia global del evento participante.',
  })
  serverSequence: string | null;

  @Column({
    name: 'reason',
    type: 'text',
    nullable: true,
    comment: 'Motivo especifico por el que este participante entro al caso.',
  })
  reason: string | null;

  @CreateDateColumn({
    name: 'created_at_server',
    type: 'timestamptz',
    precision: 3,
    comment: 'Fecha en que el participante se agrego al conflicto.',
  })
  createdAtServer: Date;
}
