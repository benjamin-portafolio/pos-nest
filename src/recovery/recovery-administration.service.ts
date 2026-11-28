import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { RecoveryEligibilityService } from './recovery-eligibility.service';
import { isUuid } from './recovery-contract';
import { recoveryError } from './recovery-errors';

interface AdminServerState {
  server_instance_id: string;
  generation_id: string;
  revision: number;
  mode: 'empty' | 'recovering' | 'active';
  recovery_enabled: boolean;
  automatic_enrollment: boolean;
  dataset_id: string | null;
  active_recovery_id: string | null;
  schema_fingerprint: string;
}
export interface RecoveryAdminAccess {
  server?: string;
  generation?: string;
  protocol?: string;
}
@Injectable()
export class RecoveryAdministrationService {
  constructor(
    private readonly db: DataSource,
    private readonly eligibility: RecoveryEligibilityService,
  ) {}

  private atDestination<T>(
    a: RecoveryAdminAccess,
    write: boolean,
    fn: (m: EntityManager, s: AdminServerState) => Promise<T>,
  ) {
    if (a.protocol !== '1' || !isUuid(a.server) || !isUuid(a.generation))
      recoveryError(400, 'invalid_admin_destination');
    return this.db.transaction(async (m) => {
      const [s] = await m.query<AdminServerState[]>(
        'SELECT * FROM server_state WHERE singleton FOR ' +
          (write ? 'UPDATE' : 'SHARE'),
      );
      if (
        !s ||
        s.server_instance_id !== a.server ||
        s.generation_id !== a.generation
      )
        recoveryError(409, 'generation_mismatch');
      return fn(m, s);
    });
  }

  status(a: RecoveryAdminAccess) {
    return this.atDestination(a, false, async (m, s) => {
      const report = await this.eligibility.inspect(m, s);
      const requests = await m.query<Record<string, unknown>[]>(
        `SELECT r.request_id,r.package_id,r.manifest_digest,
        r.source_device_id,r.decision,r.created_at,s.state AS session_state,
        s.updated_at,s.diagnostic,
        (SELECT count(*)::int FROM recovery_chunks c WHERE c.recovery_id=r.request_id) AS received_chunks
        FROM recovery_connection_requests r LEFT JOIN recovery_sessions s ON s.recovery_id=r.request_id
        WHERE r.server_instance_id=$1 AND r.generation_id=$2
        ORDER BY r.created_at DESC LIMIT 100`,
        [s.server_instance_id, s.generation_id],
      );
      return {
        protocol_version: 1,
        server_instance_id: s.server_instance_id,
        generation_id: s.generation_id,
        revision: s.revision,
        server_mode: s.mode,
        recovery_enabled: s.recovery_enabled,
        automatic_enrollment: s.automatic_enrollment,
        dataset_id: s.dataset_id,
        active_recovery_id: s.active_recovery_id,
        eligibility: report,
        requests,
      };
    });
  }

  execute(a: RecoveryAdminAccess, body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      recoveryError(400, 'invalid_admin_action');
    const b = body as Record<string, unknown>;
    if (
      Object.keys(b).some(
        (k) => !['action', 'expected_revision', 'request_id'].includes(k),
      ) ||
      typeof b.action !== 'string' ||
      ![
        'enable',
        'disable',
        'approve',
        'reject',
        'enrollment-enable',
        'enrollment-disable',
      ].includes(b.action) ||
      !Number.isSafeInteger(b.expected_revision) ||
      Number(b.expected_revision) < 0 ||
      (['approve', 'reject'].includes(String(b.action))
        ? !isUuid(b.request_id)
        : b.request_id !== undefined)
    )
      recoveryError(400, 'invalid_admin_action');
    return this.atDestination(a, true, async (m, s) => {
      if (s.revision !== b.expected_revision)
        recoveryError(409, 'admin_state_changed');
      if (
        b.action === 'enrollment-enable' ||
        b.action === 'enrollment-disable'
      ) {
        if (s.active_recovery_id || s.mode === 'recovering')
          recoveryError(409, 'active_recovery');
        if (
          b.action === 'enrollment-enable' &&
          (s.mode !== 'active' || !s.dataset_id)
        )
          recoveryError(409, 'bootstrap_unavailable');
        await m.query(
          'UPDATE server_state SET automatic_enrollment=$1 WHERE singleton',
          [b.action === 'enrollment-enable'],
        );
      } else if (b.action === 'enable') {
        const report = await this.eligibility.inspect(m, s);
        if (!report.eligible) recoveryError(409, 'destination_not_eligible');
        await m.query(
          'UPDATE server_state SET recovery_enabled=true WHERE singleton',
        );
      } else if (b.action === 'disable') {
        // The source must abort or finish first; do not strand a live attempt.
        if (s.active_recovery_id || s.mode === 'recovering')
          recoveryError(409, 'active_recovery');
        await m.query(
          'UPDATE server_state SET recovery_enabled=false WHERE singleton',
        );
        await m.query(`UPDATE recovery_connection_requests SET decision='pending'
          WHERE decision='approved' AND request_id NOT IN (SELECT recovery_id FROM recovery_sessions WHERE state='completed')`);
        await m.query(`UPDATE recovery_authorizations SET revoked=true
          WHERE issuer <> 'connection-approval' OR recovery_id NOT IN (SELECT recovery_id FROM recovery_sessions WHERE state='completed')`);
      } else {
        const [request] = await m.query<{ decision: string }[]>(
          `SELECT * FROM recovery_connection_requests
          WHERE request_id=$1 AND server_instance_id=$2 AND generation_id=$3 FOR UPDATE`,
          [b.request_id, s.server_instance_id, s.generation_id],
        );
        if (!request) recoveryError(404, 'admin_request_not_found');
        if (s.active_recovery_id || s.mode === 'recovering')
          recoveryError(409, 'active_recovery');
        const [session] = await m.query<{ state: string }[]>(
          'SELECT state FROM recovery_sessions WHERE recovery_id=$1',
          [b.request_id],
        );
        if (session && session.state !== 'aborted')
          recoveryError(409, 'admin_session_started');
        if (b.action === 'approve') {
          if (!s.recovery_enabled) recoveryError(409, 'recovery_disabled');
          if (request.decision === 'rejected')
            recoveryError(409, 'admin_request_rejected');
          const report = await this.eligibility.inspect(m, s);
          if (!report.eligible) recoveryError(409, 'destination_not_eligible');
          await m.query(
            `UPDATE recovery_authorizations SET revoked=false WHERE recovery_id=$1
            AND issuer='connection-approval' AND server_instance_id=$2 AND generation_id=$3`,
            [b.request_id, s.server_instance_id, s.generation_id],
          );
        } else {
          await m.query(
            'UPDATE recovery_authorizations SET revoked=true WHERE recovery_id=$1',
            [b.request_id],
          );
          await m.query(
            "UPDATE recovery_bootstrap_grants SET revoked=true WHERE issuer='connection-source' AND recipient=$1",
            [b.request_id],
          );
        }
        await m.query(
          'UPDATE recovery_connection_requests SET decision=$1 WHERE request_id=$2',
          [b.action === 'approve' ? 'approved' : 'rejected', b.request_id],
        );
      }
      await m.query(
        'UPDATE server_state SET revision=revision+1 WHERE singleton',
      );
      await m.query(
        'INSERT INTO recovery_audit(recovery_id,action,details) VALUES($1,$2,$3)',
        [
          b.request_id ?? null,
          b.action,
          {
            issuer: 'desktop-recovery-admin',
            server_instance_id: s.server_instance_id,
            generation_id: s.generation_id,
            expected_revision: b.expected_revision,
          },
        ],
      );
      return {
        protocol_version: 1,
        server_instance_id: s.server_instance_id,
        generation_id: s.generation_id,
        revision: s.revision + 1,
        action: b.action,
      };
    });
  }
}
