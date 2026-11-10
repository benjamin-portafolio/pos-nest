import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { recoveryError } from './recovery-errors';
import { sha256 } from './recovery-contract';
export interface BusinessAccess {
  protocol?: string;
  server?: string;
  generation?: string;
  token?: string;
  device?: string;
}
@Injectable()
export class ServerStateService {
  constructor(private readonly db: DataSource) {}
  async status() {
    const [s] = await this.db.query(
      'SELECT * FROM server_state WHERE singleton',
    );
    return {
      server_instance_id: s.server_instance_id,
      generation_id: s.generation_id,
      server_mode: s.mode,
      recovery_protocol: 1,
      sync_protocol: 2,
      baseline_high_watermark: String(s.baseline_high_watermark),
      recovery_enabled: s.recovery_enabled,
      validation_available: true,
      publication_available: true,
      commercial_recovery_complete: true,
    };
  }
  async business<T>(
    a: BusinessAccess,
    fn: (state: any, binding: any, m: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (m) => {
      const [s] = await m.query(
        'SELECT * FROM server_state WHERE singleton FOR SHARE',
      );
      if (!s) recoveryError(412, 'incompatible_schema');
      if (a.protocol !== '2' || !a.server || !a.generation)
        recoveryError(426, 'client_upgrade_required');
      if (s.server_instance_id !== a.server || s.generation_id !== a.generation)
        recoveryError(409, 'generation_mismatch');
      if (s.mode === 'recovering') recoveryError(423, 'server_recovering');
      if (s.mode !== 'active' || !s.dataset_id)
        recoveryError(409, 'bootstrap_required');
      if (!a.token || !/^[0-9a-f]{64}$/.test(a.token))
        recoveryError(401, 'binding_required');
      const [b] = await m.query(
        'SELECT * FROM sync_bindings WHERE token_hash=$1 FOR SHARE',
        [sha256(a.token)],
      );
      if (
        !b ||
        b.revoked ||
        new Date(b.expires_at).getTime() <= Date.now() ||
        b.server_instance_id !== s.server_instance_id ||
        b.generation_id !== s.generation_id ||
        b.dataset_id !== s.dataset_id ||
        b.device_id !== a.device ||
        String(b.baseline_high_watermark) !== String(s.baseline_high_watermark)
      )
        recoveryError(403, 'invalid_binding');
      return fn(s, b, m);
    });
  }
}
