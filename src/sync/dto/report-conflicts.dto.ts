import type { EventSyncStatus } from '../../enums/event-sync-status.enum';
import type { PushEventDto } from './push-events.dto';

export interface ReportConflictRefDto {
  type?: string;
  id?: string;
  ref_type?: string;
  ref_id?: string;
  relationship?: string | null;
}

export interface ReportConflictEventDto extends PushEventDto {
  reason?: string | null;
  refs?: ReportConflictRefDto[];
}

export interface ReportConflictsDto {
  device_id: string;
  events: ReportConflictEventDto[];
}

export type ReportConflictResultStatus = 'conflict' | 'duplicate' | 'rejected';

export interface ReportConflictResultDto {
  event_id: string;
  status: ReportConflictResultStatus;
  server_sequence: number | null;
  created_at_server: string | null;
  reason?: string;
  conflict_id?: string;
  original_sync_status?: EventSyncStatus;
}

export interface ReportConflictsResponseDto {
  results: ReportConflictResultDto[];
  server_time: string;
}
