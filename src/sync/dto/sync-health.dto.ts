export interface SyncHealthResponseDto {
  status: 'ok';
  latest_server_sequence: number;
  server_time: string;
}
