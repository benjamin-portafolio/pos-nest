import type { PullEventDto } from './pull-events.dto';

export interface PreflightEventRefDto {
  type: string;
  id: string;
  relationship?: string | null;
}

export interface PreflightPendingRefDto {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  base_server_sequence?: string | number | null;
  base_version?: number | null;
  changed_fields?: string[] | null;
  refs: PreflightEventRefDto[];
}

export interface PreflightEventsDto {
  device_id: string;
  last_full_pull_server_sequence?: string | number | null;
  max_events?: string | number | null;
  pending_refs: PreflightPendingRefDto[];
}

export type PreflightFullPullReason =
  | 'too_many_impacting_events'
  | 'missing_pending_refs';

export interface PreflightEventsResponseDto {
  events: PullEventDto[];
  preflight_sequence: number;
  has_more: boolean;
  requires_full_pull_before_push: boolean;
  reason: PreflightFullPullReason | null;
}
