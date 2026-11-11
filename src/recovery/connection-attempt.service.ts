import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RECOVERY_OPERATIONS } from './recovery-authorization.service';
import { isUuid, sha256 } from './recovery-contract';
import { recoveryError } from './recovery-errors';

interface Destination {
  server: string;
  generation: string;
  dataset_id: string | null;
  recovery_enabled: boolean;
  automatic_enrollment: boolean;
  mode: string;
}

const secretPattern = /^[0-9a-f]{64}$/;

@Injectable()
export class ConnectionAttemptService {
  constructor(private readonly db: DataSource) {}

  private atDestination<T>(
    server: string,
    generation: string,
    proof: string,
    fn: (m: EntityManager, s: Destination) => Promise<T>,
  ) {
    if (typeof proof !== 'string' || !secretPattern.test(proof)) {
      recoveryError(401, 'attempt_proof_required');
    }
    return this.db.transaction(async (m) => {
      const [row] = await m.query(
        'SELECT * FROM server_state WHERE singleton FOR UPDATE',
      );
      if (
        !row ||
        server !== row.server_instance_id ||
        generation !== row.generation_id
      ) {
        recoveryError(409, 'generation_mismatch');
      }
      return fn(m, { ...row, server, generation });
    });
  }

  recovery(server: string, generation: string, proof: string, body: unknown) {
    if (!body || typeof body !== 'object')
      recoveryError(400, 'invalid_attempt');
    const { request_id, package_id, manifest_digest, source_device_id } =
      body as Record<string, unknown>;
    if (
      !isUuid(request_id) ||
      !isUuid(package_id) ||
      typeof manifest_digest !== 'string' ||
      !secretPattern.test(manifest_digest) ||
      typeof source_device_id !== 'string' ||
      !source_device_id.trim() ||
      source_device_id.length > 120
    )
      recoveryError(400, 'invalid_attempt');

    return this.atDestination(server, generation, proof, async (m, s) => {
      const hash = sha256(proof);
      let [request] = await m.query(
        'SELECT * FROM recovery_connection_requests WHERE request_id=$1',
        [request_id],
      );
      if (!request) {
        if (!s.recovery_enabled) return { status: 'disabled' };
        if (s.dataset_id) recoveryError(409, 'destination_has_dataset');
        [request] = await m.query(
          `INSERT INTO recovery_connection_requests(request_id,proof_hash,server_instance_id,generation_id,package_id,manifest_digest,source_device_id)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            request_id,
            hash,
            server,
            generation,
            package_id,
            manifest_digest,
            source_device_id,
          ],
        );
      }
      if (
        request.proof_hash !== hash ||
        request.server_instance_id !== server ||
        request.generation_id !== generation ||
        request.package_id !== package_id ||
        request.manifest_digest !== manifest_digest ||
        request.source_device_id !== source_device_id
      )
        recoveryError(403, 'attempt_scope');
      if (request.decision === 'rejected') return { status: 'rejected' };
      if (request.decision === 'pending') {
        return { status: s.recovery_enabled ? 'pending' : 'disabled' };
      }

      const [session] = await m.query(
        'SELECT state,receipt FROM recovery_sessions WHERE recovery_id=$1',
        [request_id],
      );
      const completed =
        session?.state === 'completed' &&
        session.receipt?.dataset_id === s.dataset_id;
      if (!completed && !s.recovery_enabled) return { status: 'disabled' };
      if (s.dataset_id && !completed)
        recoveryError(409, 'destination_has_dataset');

      const token = sha256(
        `pos.recovery.attempt/1/${server}/${generation}/${request_id}/${proof}`,
      );
      // Preserve existing operation restrictions (e.g. failed validation) on refresh.
      const refreshed = await m.query(
        `INSERT INTO recovery_authorizations(token_hash,server_instance_id,generation_id,recovery_id,package_id,manifest_digest,source_device_id,operations,expires_at,issuer,recipient,consumed)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '30 minutes','connection-approval',$7,$9)
         ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at
         WHERE NOT recovery_authorizations.revoked RETURNING token_hash`,
        [
          sha256(token),
          server,
          generation,
          request_id,
          package_id,
          manifest_digest,
          source_device_id,
          completed ? ['progress', 'finalize'] : RECOVERY_OPERATIONS,
          !!session,
        ],
      );
      if (!refreshed.length) return { status: 'rejected' };
      if (!completed) return { status: 'approved', token };
      const enrollment = await this.enroll(
        m,
        s,
        sha256(
          `pos.bootstrap.source/1/${server}/${generation}/${s.dataset_id}/${request_id}/${proof}`,
        ),
        'connection-source',
        request_id,
      );
      return { status: 'approved', token, enrollment_token: enrollment.token };
    });
  }

  bootstrap(server: string, generation: string, proof: string) {
    return this.atDestination(server, generation, proof, async (m, s) => {
      if (!s.automatic_enrollment) return { status: 'disabled' };
      return this.enroll(
        m,
        s,
        sha256(
          `pos.bootstrap.empty/1/${server}/${generation}/${s.dataset_id}/${proof}`,
        ),
        'connection-automatic',
        'empty-installation',
      );
    });
  }

  private async enroll(
    m: EntityManager,
    s: Destination,
    token: string,
    issuer: string,
    recipient: string,
  ) {
    if (s.mode !== 'active' || !s.dataset_id)
      recoveryError(409, 'bootstrap_unavailable');
    const [dataset] = await m.query(
      'SELECT digest FROM recovery_datasets WHERE dataset_id=$1 AND generation_id=$2',
      [s.dataset_id, s.generation],
    );
    if (!dataset) recoveryError(409, 'bootstrap_unavailable');
    const hash = sha256(token);
    const [existing] = await m.query(
      'SELECT revoked FROM recovery_bootstrap_grants WHERE token_hash=$1',
      [hash],
    );
    if (existing?.revoked) recoveryError(403, 'invalid_enrollment');
    await m.query(
      `INSERT INTO recovery_bootstrap_grants(token_hash,server_instance_id,generation_id,dataset_id,expires_at,issuer,recipient)
       VALUES($1,$2,$3,$4,now()+interval '30 minutes',$5,$6)
       ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at`,
      [hash, s.server, s.generation, s.dataset_id, issuer, recipient],
    );
    if (!existing) {
      await m.query(
        "INSERT INTO recovery_audit(action,details) VALUES('bootstrap_grant',$1)",
        [{ issuer, recipient, dataset_id: s.dataset_id }],
      );
    }
    return { status: 'approved', token, bootstrap_digest: dataset.digest };
  }
}
