import type { EventSyncStatus } from '../../enums/event-sync-status.enum';

export type PushEventResultStatus =
  | 'accepted'
  | 'duplicate'
  | 'rejected'
  | 'conflict';

export interface PushEventDto {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  device_id: string;
  user_id: string;
  local_sequence?: number | null;
  base_server_sequence?: string | number | null;
  base_version?: number | null;
  created_at_local: string;
  payload: Record<string, unknown>;
}

export interface PushEventsDto {
  device_id: string;
  last_full_pull_server_sequence?: string | number | null;
  last_preflight_server_sequence?: string | number | null;
  events: PushEventDto[];
}

export interface PushEventResultDto {
  event_id: string;
  status: PushEventResultStatus;
  server_sequence: number | null;
  created_at_server: string | null;
  reason?: string;
  conflict_id?: string;
  original_sync_status?: EventSyncStatus;
}

export interface PushEventsResponseDto {
  results: PushEventResultDto[];
  server_time: string;
}
