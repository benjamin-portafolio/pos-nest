import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { recoveryError } from './recovery-errors';
import { sha256 } from './recovery-contract';
import { BusinessAccess } from './server-state.service';

/** Local operator grants enrollment; HTTP never accepts a historical user_id as authority. */
@Injectable()
export class BaselineBootstrapService {
  constructor(private readonly db: DataSource) {}
  static async grant(m: EntityManager, issuer: string, recipient: string) {
    if (
      ![issuer, recipient].every(
        (x) => typeof x === 'string' && x.trim() && x.length <= 120,
      )
    )
      recoveryError(400, 'invalid_enrollment');
    const [s] = await m.query(
      'SELECT * FROM server_state WHERE singleton FOR UPDATE',
    );
    if (s.mode !== 'active' || !s.dataset_id)
      recoveryError(409, 'bootstrap_unavailable');
    const token = randomBytes(32).toString('hex');
    await m.query(
      "INSERT INTO recovery_bootstrap_grants(token_hash,server_instance_id,generation_id,dataset_id,expires_at,issuer,recipient) VALUES($1,$2,$3,$4,now()+interval '30 minutes',$5,$6)",
      [
        sha256(token),
        s.server_instance_id,
        s.generation_id,
        s.dataset_id,
        issuer,
        recipient,
      ],
    );
    await m.query(
      "INSERT INTO recovery_audit(action,details) VALUES('bootstrap_grant',$1)",
      [{ issuer, recipient, dataset_id: s.dataset_id }],
    );
    return {
      token,
      server_instance_id: s.server_instance_id,
      generation_id: s.generation_id,
      dataset_id: s.dataset_id,
    };
  }
  private access<T>(
    a: BusinessAccess,
    fn: (m: EntityManager, s: any, g: any, d: any) => Promise<T>,
  ) {
    return this.db.transaction(async (m) => {
      const [s] = await m.query(
        'SELECT * FROM server_state WHERE singleton FOR SHARE',
      );
      if (a.protocol !== '2' || !a.server || !a.generation)
        recoveryError(426, 'client_upgrade_required');
      if (a.server !== s.server_instance_id || a.generation !== s.generation_id)
        recoveryError(409, 'generation_mismatch');
      if (s.mode === 'recovering') recoveryError(423, 'server_recovering');
      if (s.mode !== 'active' || !s.dataset_id)
        recoveryError(409, 'bootstrap_unavailable');
      if (!a.token || !/^[0-9a-f]{64}$/.test(a.token))
        recoveryError(401, 'enrollment_required');
      const [g] = await m.query(
        'SELECT * FROM recovery_bootstrap_grants WHERE token_hash=$1 FOR UPDATE',
        [sha256(a.token)],
      );
      if (
        !g ||
        g.revoked ||
        new Date(g.expires_at).getTime() <= Date.now() ||
        g.server_instance_id !== s.server_instance_id ||
        g.generation_id !== s.generation_id ||
        g.dataset_id !== s.dataset_id
      )
        recoveryError(403, 'invalid_enrollment');
      const [d] = await m.query(
        'SELECT * FROM recovery_datasets WHERE dataset_id=$1',
        [s.dataset_id],
      );
      if (!d || sha256(d.manifest_bytes) !== d.digest)
        recoveryError(422, 'bootstrap_integrity');
      return fn(m, s, g, d);
    });
  }
  descriptor(a: BusinessAccess) {
    return this.access(a, async (_m, _s, _g, d) => ({
      bytes: d.manifest_bytes,
      digest: d.digest,
    }));
  }
  chunk(a: BusinessAccess, index: number) {
    if (!Number.isSafeInteger(index) || index < 0)
      recoveryError(400, 'invalid_chunk_index');
    return this.access(a, async (m, _s, _g, d) => {
      const descriptor = JSON.parse(d.manifest_bytes.toString('utf8')).chunks[
        index
      ];
      if (!descriptor) recoveryError(404, 'bootstrap_chunk_not_found');
      const [c] = await m.query(
        'SELECT content FROM recovery_dataset_chunks WHERE dataset_id=$1 AND chunk_index=$2',
        [d.dataset_id, index],
      );
      if (
        !c ||
        sha256(c.content) !== descriptor.sha256 ||
        c.content.length !== descriptor.bytes
      )
        recoveryError(422, 'bootstrap_integrity');
      return { bytes: c.content, digest: descriptor.sha256 };
    });
  }
  bind(a: BusinessAccess, body: any) {
    if (
      !body ||
      body.protocol_version !== 1 ||
      Object.keys(body).length !== 3 ||
      !Object.hasOwn(body, 'dataset_id') ||
      !Object.hasOwn(body, 'bootstrap_digest')
    )
      recoveryError(400, 'invalid_bootstrap_ack');
    return this.access(a, async (m, s, g, d) => {
      if (
        body.dataset_id !== d.dataset_id ||
        body.bootstrap_digest !== d.digest
      )
        recoveryError(409, 'bootstrap_digest_mismatch');
      // Stable response after a lost reply without storing the plaintext secret.
      const token = sha256('pos.sync.binding/1/' + a.token);
      let device = g.device_id;
      if (!device) {
        do {
          device = randomUUID();
        } while (
          (
            await m.query('SELECT 1 FROM events WHERE device_id=$1 LIMIT 1', [
              device,
            ])
          ).length
        );
        await m.query(
          'UPDATE recovery_bootstrap_grants SET device_id=$2 WHERE token_hash=$1',
          [g.token_hash, device],
        );
        await m.query(
          "INSERT INTO sync_bindings(token_hash,server_instance_id,generation_id,dataset_id,device_id,bootstrap_digest,baseline_high_watermark,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '30 days')",
          [
            sha256(token),
            s.server_instance_id,
            s.generation_id,
            d.dataset_id,
            device,
            d.digest,
            s.baseline_high_watermark,
          ],
        );
        await m.query(
          "INSERT INTO recovery_audit(action,details) VALUES('bootstrap_bound',$1)",
          [
            {
              dataset_id: d.dataset_id,
              device_id: device,
              recipient: g.recipient,
            },
          ],
        );
      }
      const [binding] = await m.query(
        'SELECT expires_at,revoked FROM sync_bindings WHERE token_hash=$1',
        [sha256(token)],
      );
      if (
        !binding ||
        binding.revoked ||
        new Date(binding.expires_at).getTime() <= Date.now()
      )
        recoveryError(403, 'invalid_binding');
      return {
        token,
        device_id: device,
        server_instance_id: s.server_instance_id,
        generation_id: s.generation_id,
        dataset_id: d.dataset_id,
        baseline_high_watermark: String(s.baseline_high_watermark),
        expires_at: binding.expires_at,
      };
    });
  }
}
