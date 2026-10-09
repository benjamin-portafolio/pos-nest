export interface SyncHealthResponseDto {
  status: 'ok';
  capabilities: string[];
  latest_server_sequence: number;
  server_time: string;
}
