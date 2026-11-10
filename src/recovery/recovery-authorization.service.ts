import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { recoveryError } from './recovery-errors';
import { isUuid, sha256 } from './recovery-contract';
export interface RecoveryGrant {
  recovery_id: string;
  package_id: string;
  manifest_digest: string;
  source_device_id: string;
  issuer: string;
  recipient: string;
}
export const RECOVERY_OPERATIONS = [
  'eligibility',
  'start',
  'chunk',
  'progress',
  'abort',
  'validate',
  'finalize',
];
@Injectable()
export class RecoveryAuthorizationService {
  async authorize(
    m: EntityManager,
    state: any,
    token: string,
    operation: string,
    recoveryId?: string,
  ) {
    if (!token || !/^[0-9a-f]{64}$/.test(token))
      recoveryError(401, 'recovery_unauthorized');
    const [grant] = await m.query(
      'SELECT * FROM recovery_authorizations WHERE token_hash=$1 FOR UPDATE',
      [sha256(token)],
    );
    const completed =
      !state.recovery_enabled &&
      ['progress', 'finalize'].includes(operation) &&
      recoveryId &&
      (
        await m.query(
          "SELECT 1 FROM recovery_sessions WHERE recovery_id=$1 AND state='completed'",
          [recoveryId],
        )
      ).length > 0;
    if (
      (!state.recovery_enabled && !completed) ||
      !grant ||
      grant.revoked ||
      new Date(grant.expires_at).getTime() <= Date.now() ||
      grant.server_instance_id !== state.server_instance_id ||
      !grant.operations.includes(operation) ||
      (recoveryId && grant.recovery_id !== recoveryId)
    )
      recoveryError(403, 'recovery_forbidden');
    return grant;
  }
  /** Only called by the local administrative tool; no HTTP route. Renew keeps ID/digest. */
  async grant(m: EntityManager, input: RecoveryGrant): Promise<string> {
    if (
      !isUuid(input.recovery_id) ||
      !isUuid(input.package_id) ||
      !/^[0-9a-f]{64}$/.test(input.manifest_digest) ||
      ![input.source_device_id, input.issuer, input.recipient].every(
        (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 120,
      )
    )
      recoveryError(400, 'invalid_grant');
    const [s] = await m.query(
      'SELECT * FROM server_state WHERE singleton FOR UPDATE',
    );
    const [session] = await m.query(
      'SELECT * FROM recovery_sessions WHERE recovery_id=$1 OR package_id=$2',
      [input.recovery_id, input.package_id],
    );
    const completed =
      session?.state === 'completed' &&
      session.receipt?.dataset_id === s.dataset_id;
    if (!s.recovery_enabled && !completed)
      recoveryError(403, 'recovery_disabled');
    if (
      (s.dataset_id && !completed) ||
      (s.active_recovery_id && s.active_recovery_id !== input.recovery_id)
    )
      recoveryError(409, 'active_recovery');
    if (
      session &&
      (session.recovery_id !== input.recovery_id ||
        session.package_id !== input.package_id ||
        session.manifest_digest !== input.manifest_digest ||
        session.source_device_id !== input.source_device_id ||
        session.state === 'aborted')
    )
      recoveryError(409, 'digest_reuse');
    await m.query(
      'UPDATE recovery_authorizations SET revoked=true WHERE recovery_id=$1',
      [input.recovery_id],
    );
    const token = randomBytes(32).toString('hex');
    await m.query(
      `INSERT INTO recovery_authorizations(token_hash,server_instance_id,generation_id,recovery_id,package_id,manifest_digest,source_device_id,operations,expires_at,issuer,recipient,consumed)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '30 minutes',$9,$10,$11)`,
      [
        sha256(token),
        s.server_instance_id,
        s.generation_id,
        input.recovery_id,
        input.package_id,
        input.manifest_digest,
        input.source_device_id,
        session?.state === 'completed'
          ? ['progress', 'finalize']
          : RECOVERY_OPERATIONS,
        input.issuer,
        input.recipient,
        !!session,
      ],
    );
    await m.query(
      `INSERT INTO recovery_audit(recovery_id,action,details) VALUES($1,'grant',$2)`,
      [input.recovery_id, { ...input, renewed: !!session }],
    );
    return token;
  }
}
