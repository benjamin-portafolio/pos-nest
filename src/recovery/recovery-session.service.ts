import { RECOVERY_VALIDATED_TABLES } from './recovery-logical-schema';
import { RecoveryStagingService } from './recovery-staging.service';
import { RecoveryPublicationService } from './recovery-publication.service';
import {
  canonical,
  RecoveryValidationRequest,
  RecoveryFinalizationRequest,
} from './recovery-contract';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RecoveryAuthorizationService } from './recovery-authorization.service';
import { RecoveryEligibilityService } from './recovery-eligibility.service';
import {
  parseManifest,
  RECOVERY_LIMITS,
  sha256,
  validateChunk,
} from './recovery-contract';
import { recoveryError } from './recovery-errors';
export interface RecoveryAccess {
  token: string;
  protocol: string;
  server: string;
  generation: string;
}
@Injectable()
export class RecoverySessionService {
  constructor(
    private readonly db: DataSource,
    private readonly auth: RecoveryAuthorizationService,
    private readonly eligibility: RecoveryEligibilityService,
    private readonly staging: RecoveryStagingService,
    private readonly publication: RecoveryPublicationService,
  ) {}
  private async access<T>(
    a: RecoveryAccess,
    op: string,
    id: string | undefined,
    write: boolean,
    fn: (m: EntityManager, s: any, g: any) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (m) => {
      const [s] = await m.query(
        `SELECT * FROM server_state WHERE singleton FOR ${write ? 'UPDATE' : 'SHARE'}`,
      );
      if (!s) recoveryError(412, 'incompatible_schema');
      if (a.protocol !== '1') recoveryError(412, 'incompatible_contract');
      if (a.server !== s.server_instance_id || a.generation !== s.generation_id)
        recoveryError(409, 'generation_mismatch');
      const g = await this.auth.authorize(m, s, a.token, op, id);
      if (g.generation_id !== s.generation_id)
        recoveryError(409, 'generation_mismatch');
      return fn(m, s, g);
    });
  }
  private response(s: any, session?: any) {
    return {
      protocol_version: 1,
      server_instance_id: s.server_instance_id,
      generation_id: session?.candidate_generation_id ?? s.generation_id,
      recovery_id: session?.recovery_id ?? null,
      revision: session?.revision ?? s.revision,
      state: session?.state ?? s.mode,
      server_time: new Date().toISOString(),
    };
  }
  eligibilityFor(a: RecoveryAccess) {
    return this.access(a, 'eligibility', undefined, false, async (m, s) => ({
      ...this.response(s),
      ...(await this.eligibility.inspect(m, s)),
      limits: RECOVERY_LIMITS,
      capabilities: ['recovery_transport_v1', 'baseline_bootstrap_required'],
      validation_available: true,
      publication_available: true,
      validated_entities: [...RECOVERY_VALIDATED_TABLES, 'event_provenance'],
      commercial_recovery_complete: true,
    }));
  }
  start(a: RecoveryAccess, bytes: Buffer, digest: string, key: string) {
    const manifest = parseManifest(bytes);
    if (digest !== sha256(bytes)) recoveryError(422, 'manifest_integrity');
    if (key !== manifest.package_id)
      recoveryError(400, 'idempotency_key_required');
    return this.access(a, 'start', undefined, true, async (m, s, g) => {
      if (
        manifest.package_id !== g.package_id ||
        digest !== g.manifest_digest ||
        manifest.source.device_id !== g.source_device_id
      )
        recoveryError(403, 'recovery_scope');
      const [prior] = await m.query(
        'SELECT * FROM recovery_sessions WHERE package_id=$1 OR recovery_id=$2',
        [g.package_id, g.recovery_id],
      );
      if (prior) {
        if (
          prior.manifest_digest !== digest ||
          prior.recovery_id !== g.recovery_id ||
          !prior.manifest_bytes.equals(bytes)
        )
          recoveryError(409, 'digest_reuse');
        if (prior.state === 'aborted') recoveryError(409, 'session_aborted');
        return this.response(s, prior);
      }
      if (g.consumed) recoveryError(409, 'authorization_consumed');
      const e = await this.eligibility.inspect(m, s);
      if (!e.eligible)
        recoveryError(
          e.reasons.includes('incompatible_schema') ? 412 : 409,
          e.reasons[0],
          e,
        );
      const [session] = await m.query(
        `INSERT INTO recovery_sessions(recovery_id,package_id,manifest_digest,manifest_bytes,source_device_id,candidate_generation_id,state)
        VALUES($1,$2,$3,$4,$5,$6,'receiving') RETURNING *`,
        [
          g.recovery_id,
          g.package_id,
          digest,
          bytes,
          g.source_device_id,
          g.generation_id,
        ],
      );
      await m.query(
        "UPDATE server_state SET mode='recovering',active_recovery_id=$1,revision=revision+1 WHERE singleton",
        [g.recovery_id],
      );
      await m.query(
        'UPDATE recovery_authorizations SET consumed=true WHERE token_hash=$1',
        [g.token_hash],
      );
      await this.audit(m, g.recovery_id, 'receiving', {
        manifest_digest: digest,
        package_id: g.package_id,
      });
      return this.response(s, session);
    });
  }
  private async session(m: EntityManager, id: string) {
    const [v] = await m.query(
      'SELECT * FROM recovery_sessions WHERE recovery_id=$1 FOR UPDATE',
      [id],
    );
    if (!v) recoveryError(404, 'recovery_not_found');
    return v;
  }
  chunk(
    a: RecoveryAccess,
    id: string,
    index: number,
    bytes: Buffer,
    digest: string,
  ) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= RECOVERY_LIMITS.chunks
    )
      recoveryError(400, 'invalid_chunk_index');
    return this.access(a, 'chunk', id, true, async (m, s) => {
      const v = await this.session(m, id);
      if (v.state !== 'receiving' || s.active_recovery_id !== id)
        recoveryError(409, 'state_changed');
      const descriptor = parseManifest(v.manifest_bytes).chunks[index];
      if (!descriptor) recoveryError(400, 'unexpected_chunk');
      const [prior] = await m.query(
        'SELECT * FROM recovery_chunks WHERE recovery_id=$1 AND chunk_index=$2',
        [id, index],
      );
      if (prior) {
        if (
          digest !== prior.digest ||
          !Buffer.isBuffer(bytes) ||
          !bytes.equals(prior.content)
        )
          recoveryError(409, 'digest_reuse');
        return {
          ...this.response(s, v),
          duplicate: true,
          index,
          digest: prior.digest,
        };
      }
      if (digest !== descriptor.sha256) recoveryError(422, 'chunk_integrity');
      validateChunk(bytes, descriptor);
      await m.query(
        'INSERT INTO recovery_chunks(recovery_id,chunk_index,digest,content,row_count) VALUES($1,$2,$3,$4,$5)',
        [id, index, digest, bytes, descriptor.rows],
      );
      await m.query(
        'UPDATE recovery_sessions SET revision=revision+1,updated_at=now() WHERE recovery_id=$1',
        [id],
      );
      const next = await this.session(m, id);
      return { ...this.response(s, next), duplicate: false, index, digest };
    });
  }
  progress(a: RecoveryAccess, id: string, offset = 0) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset >= RECOVERY_LIMITS.chunks
    )
      recoveryError(400, 'invalid_offset');
    return this.access(a, 'progress', id, false, async (m, s) => {
      const v = await this.session(m, id),
        manifest = parseManifest(v.manifest_bytes);
      const received = await m.query(
        'SELECT chunk_index,digest,octet_length(content) AS bytes FROM recovery_chunks WHERE recovery_id=$1 AND chunk_index >= $2 AND chunk_index < $3 ORDER BY chunk_index',
        [id, offset, offset + RECOVERY_LIMITS.progress_page],
      );
      const page = manifest.chunks.slice(
        offset,
        offset + RECOVERY_LIMITS.progress_page,
      );
      return {
        ...this.response(s, v),
        manifest_digest: v.manifest_digest,
        diagnostic: v.diagnostic,
        receipt: v.receipt,
        received,
        missing: page
          .filter((c) => !received.some((r) => r.chunk_index === c.index))
          .map((c) => c.index),
        next_offset:
          offset + page.length < manifest.chunks.length
            ? offset + page.length
            : null,
        total_chunks: manifest.chunks.length,
      };
    });
  }
  abort(a: RecoveryAccess, id: string, revision: number, reason: string) {
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.length > 500
    )
      recoveryError(400, 'invalid_abort');
    return this.access(a, 'abort', id, true, async (m, s) => {
      const v = await this.session(m, id);
      if (v.state === 'completed') recoveryError(409, 'already_completed');
      if (v.state === 'aborted') return this.response(s, v);
      if (v.revision !== revision || s.active_recovery_id !== id)
        recoveryError(409, 'state_changed');
      // S2 staging never touches business. Check again; never unlock unexpected data.
      const e = await this.eligibility.inspect(m, s);
      if (
        e.reasons.some(
          (r) => r !== 'unpublished_staging' && r !== 'active_recovery',
        )
      )
        recoveryError(409, 'abort_destination_changed', e);
      await m.query('DELETE FROM recovery_rows WHERE recovery_id=$1', [id]);
      await m.query('DELETE FROM recovery_chunks WHERE recovery_id=$1', [id]);
      await m.query(
        "UPDATE recovery_sessions SET state='aborted',revision=revision+1,updated_at=now(),diagnostic=$2 WHERE recovery_id=$1",
        [id, { reason }],
      );
      const next = await this.session(m, id);
      await m.query(
        "UPDATE server_state SET mode='empty',active_recovery_id=null,revision=revision+1 WHERE singleton",
      );
      // Revoke mutation scope, retain progress/abort for lost responses until TTL.
      await m.query(
        "UPDATE recovery_authorizations SET operations=ARRAY['progress','abort'] WHERE recovery_id=$1",
        [id],
      );
      await this.audit(m, id, 'aborted', { reason });
      return this.response(s, next);
    });
  }
  async validate(
    a: RecoveryAccess,
    id: string,
    request: RecoveryValidationRequest,
  ) {
    this.operationRequest(request, 'manifest_digest');
    const prior = await this.access(a, 'validate', id, true, async (m, s) => {
      const v = await this.session(m, id);
      if (request.manifest_digest !== v.manifest_digest)
        recoveryError(409, 'digest_reuse');
      if (
        ['ready_to_commit', 'failed_validation', 'completed'].includes(v.state)
      )
        return {
          ...this.response(s, v),
          diagnostic: v.diagnostic,
          validation_digest: v.validation_digest,
        };
      if (
        s.active_recovery_id !== id ||
        !['receiving', 'validating'].includes(v.state)
      )
        recoveryError(409, 'state_changed');
      if (v.state === 'receiving') {
        if (request.expected_revision !== v.revision)
          recoveryError(409, 'state_changed');
        await m.query(
          "UPDATE recovery_sessions SET state='validating',revision=revision+1,updated_at=now() WHERE recovery_id=$1",
          [id],
        );
        await this.audit(m, id, 'validating', {
          manifest_digest: v.manifest_digest,
        });
      }
      return null;
    });
    if (prior) return prior;
    return this.access(a, 'validate', id, true, async (m, s) => {
      const v = await this.session(m, id);
      if (
        ['ready_to_commit', 'failed_validation', 'completed'].includes(v.state)
      )
        return {
          ...this.response(s, v),
          diagnostic: v.diagnostic,
          validation_digest: v.validation_digest,
        };
      if (v.state !== 'validating' || s.active_recovery_id !== id)
        recoveryError(409, 'state_changed');
      await m.query('SAVEPOINT recovery_validation');
      let diagnostic: any;
      try {
        const e = await this.eligibility.inspect(m, s);
        if (e.reasons.some((r) => r !== 'active_recovery'))
          recoveryError(409, 'destination_changed', e);
        const { manifest, counts } = await this.staging.load(m, v);
        const importedAt = new Date().toISOString();
        const summary = await this.publication.materialize(
          m,
          id,
          manifest,
          importedAt,
        );
        // Trial business never survives validation. Keep original typed rows only.
        diagnostic = {
          valid: true,
          manifest_digest: v.manifest_digest,
          counts,
          summary,
          validated_at: importedAt,
          timestamp_origin: 'import',
          coverage: manifest.coverage,
        };
      } catch (error) {
        if (!error.getStatus && !/^(22|23)/.test(error.code ?? '')) throw error;
        diagnostic = {
          valid: false,
          error: error.getResponse?.() ?? {
            code: 'business_constraint',
            constraint: error.constraint ?? null,
          },
        };
      }
      await m.query('ROLLBACK TO SAVEPOINT recovery_validation');
      await m.query('RELEASE SAVEPOINT recovery_validation');
      // Re-read/hash typed transport after rollback; no rows from a failed trial.
      if (diagnostic.valid) await this.staging.load(m, v);
      const digest = sha256(canonical(diagnostic));
      await m.query(
        'UPDATE recovery_sessions SET state=$2,diagnostic=$3,validation_digest=$4,revision=revision+1,updated_at=now() WHERE recovery_id=$1',
        [
          id,
          diagnostic.valid ? 'ready_to_commit' : 'failed_validation',
          diagnostic,
          digest,
        ],
      );
      await this.audit(
        m,
        id,
        diagnostic.valid ? 'ready_to_commit' : 'failed_validation',
        { validation_digest: digest },
      );
      return {
        ...this.response(s, await this.session(m, id)),
        diagnostic,
        validation_digest: digest,
      };
    });
  }
  finalize(
    a: RecoveryAccess,
    id: string,
    request: RecoveryFinalizationRequest,
  ) {
    this.operationRequest(request, 'validation_digest');
    return this.access(a, 'finalize', id, true, async (m, s) => {
      const v = await this.session(m, id);
      if (request.validation_digest !== v.validation_digest)
        recoveryError(409, 'digest_reuse');
      if (v.state === 'completed')
        return { ...this.response(s, v), receipt: v.receipt };
      if (
        v.state !== 'ready_to_commit' ||
        s.active_recovery_id !== id ||
        v.revision !== request.expected_revision
      )
        recoveryError(409, 'state_changed');
      if (
        !v.diagnostic?.valid ||
        sha256(canonical(v.diagnostic)) !== v.validation_digest
      )
        recoveryError(422, 'validation_integrity');
      const e = await this.eligibility.inspect(m, s);
      if (e.reasons.some((r) => r !== 'active_recovery'))
        recoveryError(409, 'destination_changed', e);
      const { manifest, counts } = await this.staging.load(m, v);
      if (canonical(counts) !== canonical(v.diagnostic.counts))
        recoveryError(422, 'validation_integrity');
      const importedAt = new Date().toISOString();
      const summary = await this.publication.materialize(
        m,
        id,
        manifest,
        importedAt,
      );
      if (canonical(summary) !== canonical(v.diagnostic.summary))
        recoveryError(422, 'validation_integrity');
      const artifact = await this.publication.dataset(
        m,
        id,
        manifest,
        summary,
        importedAt,
      );
      await this.publication.advanceSequence(
        m,
        manifest.baseline_high_watermark,
      );
      const receipt = {
        protocol_version: 1,
        recovery_id: id,
        package_id: v.package_id,
        server_instance_id: s.server_instance_id,
        generation_id: s.generation_id,
        dataset_id: artifact.dataset_id,
        baseline_high_watermark: manifest.baseline_high_watermark,
        bootstrap_digest: artifact.bootstrap_digest,
        manifest_digest: v.manifest_digest,
        validation_digest: v.validation_digest,
        summary,
        completed_at: new Date().toISOString(),
      };
      await m.query(
        "UPDATE recovery_sessions SET state='completed',receipt=$2,revision=revision+1,updated_at=now() WHERE recovery_id=$1",
        [id, receipt],
      );
      await m.query(
        "UPDATE server_state SET mode='active',dataset_id=$1,baseline_high_watermark=$2,active_recovery_id=null,revision=revision+1 WHERE singleton",
        [artifact.dataset_id, manifest.baseline_high_watermark],
      );
      await this.audit(m, id, 'completed', receipt);
      return { ...this.response(s, await this.session(m, id)), receipt };
    });
  }
  private operationRequest(request: any, digest: string) {
    if (
      !request ||
      request.protocol_version !== 1 ||
      !Number.isInteger(request.expected_revision) ||
      request.expected_revision < 0 ||
      typeof request[digest] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(request[digest]) ||
      Object.keys(request).some(
        (k) => !['protocol_version', 'expected_revision', digest].includes(k),
      )
    )
      recoveryError(400, 'invalid_recovery_operation');
  }
  private audit(
    m: EntityManager,
    id: string,
    action: string,
    details: unknown,
  ) {
    return m.query(
      'INSERT INTO recovery_audit(recovery_id,action,details) VALUES($1,$2,$3)',
      [id, action, details],
    );
  }
}
