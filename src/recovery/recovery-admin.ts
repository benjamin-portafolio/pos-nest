import { CreateConnectionAttempts1794355200000 } from '../migrations/1794355200000-CreateConnectionAttempts';
import { isUuid } from './recovery-contract';
import { BaselineBootstrapService } from './baseline-bootstrap.service';
import { CreateRecoveryDataset1794182400000 } from '../migrations/1794182400000-CreateRecoveryDataset';
/** Local-only operator tool. Never loads .env or accepts an HTTP request. */
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { CreateRecoveryProtocol1794096000000 } from '../migrations/1794096000000-CreateRecoveryProtocol';
import {
  RecoveryAuthorizationService,
  RecoveryGrant,
} from './recovery-authorization.service';

async function main() {
  const [command, inputFile, outputFile] = process.argv.slice(2);
  if (
    ![
      'migrate',
      'enable',
      'disable',
      'grant',
      'bootstrap-grant',
      'status',
      'requests',
      'approve',
      'reject',
      'enrollment-enable',
      'enrollment-disable',
    ].includes(command)
  )
    throw new Error(
      'Usage: recovery-admin migrate|enable|disable|status|requests|enrollment-enable|enrollment-disable OR approve|reject request-id OR grant|bootstrap-grant input.json secret-output.json',
    );
  const db = await new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    synchronize: false,
    migrationsRun: false,
    migrations: [
      CreateRecoveryProtocol1794096000000,
      CreateRecoveryDataset1794182400000,
      CreateConnectionAttempts1794355200000,
    ],
  }).initialize();
  try {
    if (command === 'migrate') {
      console.log(
        (await db.runMigrations({ transaction: 'all' })).map((m) => m.name),
      );
      return;
    }
    const result = await db.transaction(async (m) => {
      const [s] = await m.query(
        'SELECT * FROM server_state WHERE singleton FOR UPDATE',
      );
      if (command === 'status') return s;
      if (command === 'requests') {
        return m.query(
          `SELECT request_id,server_instance_id,generation_id,package_id,manifest_digest,source_device_id,decision,created_at
          FROM recovery_connection_requests WHERE server_instance_id=$1 AND generation_id=$2 ORDER BY created_at DESC`,
          [s.server_instance_id, s.generation_id],
        );
      }
      if (command === 'enrollment-enable' || command === 'enrollment-disable') {
        const enabled = command === 'enrollment-enable';
        await m.query(
          'UPDATE server_state SET automatic_enrollment=$1 WHERE singleton',
          [enabled],
        );
        await m.query(
          'INSERT INTO recovery_audit(action,details) VALUES($1,$2)',
          [command, { automatic_enrollment: enabled }],
        );
        return { automatic_enrollment: enabled };
      }
      if (command === 'approve' || command === 'reject') {
        if (!isUuid(inputFile)) throw new Error('Expected request UUID');
        const approving = command === 'approve';
        if (
          approving &&
          (!s.recovery_enabled ||
            s.dataset_id ||
            (s.active_recovery_id && s.active_recovery_id !== inputFile))
        ) {
          throw new Error('Destination unavailable for approval');
        }
        const decision = approving ? 'approved' : 'rejected';
        const [request] = await m.query(
          `UPDATE recovery_connection_requests SET decision=$1
          WHERE request_id=$2 AND server_instance_id=$3 AND generation_id=$4
          AND (decision <> 'rejected' OR NOT $5)
          RETURNING package_id,manifest_digest,source_device_id`,
          [
            decision,
            inputFile,
            s.server_instance_id,
            s.generation_id,
            approving,
          ],
        );
        if (!request) throw new Error('Request unavailable in this generation');
        if (approving) {
          await m.query(
            "UPDATE recovery_authorizations SET revoked=false WHERE recovery_id=$1 AND issuer='connection-approval' AND server_instance_id=$2 AND generation_id=$3",
            [inputFile, s.server_instance_id, s.generation_id],
          );
        } else {
          await m.query(
            'UPDATE recovery_authorizations SET revoked=true WHERE recovery_id=$1',
            [inputFile],
          );
          await m.query(
            "UPDATE recovery_bootstrap_grants SET revoked=true WHERE issuer='connection-source' AND recipient=$1",
            [inputFile],
          );
        }
        await m.query(
          'INSERT INTO recovery_audit(recovery_id,action,details) VALUES($1,$2,$3)',
          [
            inputFile,
            command,
            {
              ...request,
              issuer:
                process.env.USER ?? process.env.USERNAME ?? 'local-operator',
            },
          ],
        );
        return { request_id: inputFile, decision };
      }
      if (command === 'enable' || command === 'disable') {
        if (command === 'enable' && s.dataset_id)
          throw new Error('Published dataset cannot be recovered again');
        await m.query(
          'UPDATE server_state SET recovery_enabled=$1,revision=revision+1 WHERE singleton',
          [command === 'enable'],
        );
        if (command === 'disable') {
          await m.query(`UPDATE recovery_connection_requests SET decision='pending'
            WHERE decision='approved' AND request_id NOT IN (SELECT recovery_id FROM recovery_sessions WHERE state='completed')`);
          await m.query(`UPDATE recovery_authorizations SET revoked=true
            WHERE issuer <> 'connection-approval' OR recovery_id NOT IN
              (SELECT recovery_id FROM recovery_sessions WHERE state='completed')`);
        }
        await m.query(
          'INSERT INTO recovery_audit(action,details) VALUES($1,$2)',
          [command, { issuer: process.env.USER ?? 'local-operator' }],
        );
        return { recovery_enabled: command === 'enable', mode: s.mode };
      }
      if (!inputFile || !outputFile)
        throw new Error(
          'Grant requires input JSON and a new private output path',
        );
      const input = JSON.parse(
        readFileSync(inputFile, 'utf8'),
      ) as RecoveryGrant;
      if (command === 'bootstrap-grant') {
        const grant = await BaselineBootstrapService.grant(
          m,
          input.issuer,
          input.recipient,
        );
        writeFileSync(outputFile, JSON.stringify(grant), {
          mode: 0o600,
          flag: 'wx',
        });
        return { dataset_id: grant.dataset_id, secret_file: outputFile };
      }
      const token = await new RecoveryAuthorizationService().grant(m, input);
      // Exclusive create + 0600; never print secret or replace an existing file.
      writeFileSync(
        outputFile,
        JSON.stringify({
          token,
          recovery_id: input.recovery_id,
          package_id: input.package_id,
          server_instance_id: s.server_instance_id,
          generation_id: s.generation_id,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      return { recovery_id: input.recovery_id, secret_file: outputFile };
    });
    console.log(JSON.stringify(result));
  } finally {
    await db.destroy();
  }
}
if (require.main === module)
  void main().catch((e: unknown) => {
    console.error(
      e instanceof Error ? e.message : 'Administrative operation failed',
    );
    process.exitCode = 1;
  });
