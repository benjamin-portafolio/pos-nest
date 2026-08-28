import type { SyncConflictParticipantRole } from '../../enums/sync-conflict-participant-role.enum';
import type { SyncConflictStatus } from '../../enums/sync-conflict-status.enum';

export interface ListConflictsQueryDto {
  status?: SyncConflictStatus | string;
  ref_type?: string;
  ref_id?: string;
  limit?: string | number | null;
}

export interface ListConflictParticipantDto {
  participant_id: string;
  event_id: string;
  participant_role: SyncConflictParticipantRole;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  sync_status: string;
  server_sequence: number | null;
  reason: string | null;
  created_at_server: string;
}

export interface ListConflictDto {
  conflict_id: string;
  conflict_type: string;
  ref_type: string;
  ref_id: string;
  status: SyncConflictStatus;
  default_winner_event_id: string | null;
  resolution_event_id: string | null;
  reason: string | null;
  created_at_server: string;
  updated_at_server: string;
  participants: ListConflictParticipantDto[];
}

export interface ListConflictsResponseDto {
  conflicts: ListConflictDto[];
}
