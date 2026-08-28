export interface PullEventsQueryDto {
  device_id?: string;
  since?: string | number | null;
  limit?: string | number | null;
}

export interface PullEventDto {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  device_id: string;
  user_id: string;
  local_sequence: number | null;
  server_sequence: number;
  base_server_sequence: number | null;
  base_version: number | null;
  created_at_local: string;
  created_at_server: string;
  payload: Record<string, unknown>;
  sync_status: 'synced';
}

export interface PullEventsResponseDto {
  events: PullEventDto[];
  next_cursor: number;
  has_more: boolean;
}
