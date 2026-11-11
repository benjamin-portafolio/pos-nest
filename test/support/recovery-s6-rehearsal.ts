/** Fixture-only administrative bridge. Never registered in AppModule. */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DataSource } from 'typeorm';
import { BaselineBootstrapService } from '../../src/recovery/baseline-bootstrap.service';
import { isUuid } from '../../src/recovery/recovery-contract';

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
      const request = new URL(req.url, 'http://127.0.0.1');
      if (request.pathname === '/approve') {
        const id = request.searchParams.get('id');
        if (!isUuid(id)) throw new Error('Invalid fixture request ID');
        await promisify(execFile)(process.execPath, [
          '-r',
          'ts-node/register',
          'src/recovery/recovery-admin.ts',
          'approve',
          id,
        ]);
        res.end('{}');
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
