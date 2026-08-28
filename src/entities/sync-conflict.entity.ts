import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SyncConflictStatus } from '../enums/sync-conflict-status.enum';

@Entity({ name: 'sync_conflicts' })
@Index('ix_sync_conflicts_status', ['status'])
@Index('ix_sync_conflicts_ref', ['conflictType', 'refType', 'refId'])
export class SyncConflictEntity {
  @PrimaryGeneratedColumn('uuid', {
    name: 'conflict_id',
    comment: 'UUID del caso de conflicto centralizado.',
  })
  conflictId: string;

  @Column({
    name: 'conflict_type',
    type: 'varchar',
    length: 80,
    comment: "Tipo de conflicto, por ejemplo 'unique_key_conflict'.",
  })
  conflictType: string;

  @Column({
    name: 'ref_type',
    type: 'varchar',
    length: 80,
    comment: 'Espacio de identificacion usado para agrupar el conflicto.',
  })
  refType: string;

  @Column({
    name: 'ref_id',
    type: 'varchar',
    length: 180,
    comment: 'Valor de referencia usado para agrupar el conflicto.',
  })
  refId: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: SyncConflictStatus,
    enumName: 'sync_conflict_status',
    default: SyncConflictStatus.OPEN,
    comment: 'Estado administrativo del caso de conflicto.',
  })
  status: SyncConflictStatus;

  @Column('uuid', {
    name: 'default_winner_event_id',
    nullable: true,
    comment: 'Evento que gano por defecto al ser aceptado primero.',
  })
  defaultWinnerEventId: string | null;

  @Column('uuid', {
    name: 'resolution_event_id',
    nullable: true,
    comment: 'Evento posterior que resolvio o descarto el conflicto.',
  })
  resolutionEventId: string | null;

  @Column({
    name: 'reason',
    type: 'text',
    nullable: true,
    comment: 'Motivo inicial con el que se abrio el conflicto.',
  })
  reason: string | null;

  @CreateDateColumn({
    name: 'created_at_server',
    type: 'timestamptz',
    precision: 3,
    comment: 'Fecha en que el servidor abrio el conflicto.',
  })
  createdAtServer: Date;

  @UpdateDateColumn({
    name: 'updated_at_server',
    type: 'timestamptz',
    precision: 3,
    comment: 'Fecha de ultima actualizacion del conflicto.',
  })
  updatedAtServer: Date;
}
