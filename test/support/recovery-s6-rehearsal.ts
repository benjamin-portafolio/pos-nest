/** Fixture-only administrative bridge. Never registered in AppModule. */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RecoveryAuthorizationService } from '../../src/recovery/recovery-authorization.service';
import { BaselineBootstrapService } from '../../src/recovery/baseline-bootstrap.service';
import { canonical, sha256 } from '../../src/recovery/recovery-contract';

export async function runRecoveryS6Rehearsal(
  db: DataSource,
  url: string,
  preparedPath: string,
) {
  const root = dirname(preparedPath);
  if (!root.startsWith('/tmp/pos-recovery-s4-commercial-'))
    throw new Error('Private fixture directory required');
  const [state] = await db.query('SELECT * FROM server_state');
  if (state.mode !== 'empty' || state.dataset_id)
    throw new Error('Empty fixture destination required');
  let administrativeError: unknown;
  const bridge = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') throw new Error('POST required');
      if (req.url === '/grant') {
        const prepared = JSON.parse(
          readFileSync(join(root, 's6/prepared.json'), 'utf8'),
        );
        const manifest = JSON.parse(
          readFileSync(join(prepared.package_path, 'manifest.json'), 'utf8'),
        );
        const token = await db.transaction((m) =>
          new RecoveryAuthorizationService().grant(m, {
            recovery_id: randomUUID(),
            package_id: manifest.package_id,
            manifest_digest: sha256(canonical(manifest)),
            source_device_id: manifest.source.device_id,
            issuer: 'S6-fixture-only',
            recipient: 'A-UI',
          }),
        );
        res.end(JSON.stringify({ token }));
      } else if (req.url === '/enroll') {
        const grant = await db.transaction((m) =>
          BaselineBootstrapService.grant(
            m,
            'S6-fixture-only',
            'isolated-device',
          ),
        );
        res.end(JSON.stringify(grant));
      } else throw new Error('Unknown fixture action');
    } catch (error) {
      administrativeError = error;
      res.statusCode = 500;
      res.end('{"error":"fixture administrative action failed"}');
    }
  });
  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const address = bridge.address() as { port: number };
  const input = join(root, 's6-input.json');
  writeFileSync(
    input,
    JSON.stringify({
      url,
      bridge: `http://127.0.0.1:${address.port}`,
      prepared: preparedPath,
      server: state.server_instance_id,
      generation: state.generation_id,
    }),
    { mode: 0o600 },
  );
  try {
    const worker = await promisify(execFile)(
      'flutter',
      [
        'test',
        '--no-pub',
        'test/support/recovery_s6_ui_worker.dart',
        '--reporter',
        'expanded',
      ],
      {
        cwd: '/Users/benjamin/Projects/POS/pos_flutter',
        env: { ...process.env, POS_RECOVERY_S6_INPUT: input },
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    writeFileSync('/tmp/pos-recovery-s6-ui.log', worker.stdout + worker.stderr);
    if (!worker.stdout.includes('All tests passed!'))
      throw new Error('UI rehearsal did not pass');
    if (administrativeError) throw administrativeError;
    const report = JSON.parse(
      readFileSync(join(root, 's6-report.json'), 'utf8'),
    );
    const [published] = await db.query(
      'SELECT mode,dataset_id,generation_id,baseline_high_watermark FROM server_state',
    );
    if (
      published.mode !== 'active' ||
      published.dataset_id !== report.dataset_id
    )
      throw new Error('Published dataset mismatch');
    report.postgres = published;
    const output = process.env.POS_RECOVERY_S6_REPORT;
    if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    if (failure.stdout || failure.stderr)
      writeFileSync(
        '/tmp/pos-recovery-s6-ui.log',
        (failure.stdout ?? '') + (failure.stderr ?? ''),
      );
    throw error;
  } finally {
    await new Promise<void>((resolve, reject) =>
      bridge.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
