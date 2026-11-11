import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { CreateRecoveryProtocol1794096000000 } from '../migrations/1794096000000-CreateRecoveryProtocol';
import { CreateConnectionAttempts1794355200000 } from '../migrations/1794355200000-CreateConnectionAttempts';
import { CreateRecoveryDataset1794182400000 } from '../migrations/1794182400000-CreateRecoveryDataset';
import { RecoveryAuthorizationService } from './recovery-authorization.service';
import { BaselineBootstrapService } from './baseline-bootstrap.service';
import { InventoryUnitSeedService } from '../inventory/inventory-unit-seed.service';
import { canonical, sha256 } from './recovery-contract';
import { RECOVERY_KEYS } from './recovery-logical-schema';
import { BUSINESS_TABLES } from './recovery-schema';
import { authorCommercialRecoveryFixture } from '../../test/support/recovery-commercial-fixture';
import { runRecoveryS6Rehearsal } from '../../test/support/recovery-s6-rehearsal';

jest.setTimeout(30000);
const integration =
  process.env.RUN_RECOVERY_S4_POSTGRES === '1' ? describe : describe.skip;
integration(
  'S4: isolated PostgreSQL, real HTTP module, S3 Flutter package',
  () => {
    let db: DataSource,
      child: ChildProcess,
      url: string,
      token: string,
      state: any,
      id: string,
      manifest: any,
      chunks: Buffer[],
      digest: string;
    const fixture = join(process.cwd(), 'test/fixtures/recovery_s3');
    const sourceManifest = JSON.parse(
      readFileSync(join(fixture, 'manifest.json'), 'utf8'),
    );
    const sourceChunks = sourceManifest.chunks.map((c: any) =>
      readFileSync(join(fixture, c.file)),
    );
    async function connect() {
      db = await new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port: 55484,
        username: 'recovery_test',
        database: 'pos_nest_test_recovery_s4',
        entities: [__dirname + '/../entities/*.entity.ts'],
        synchronize: false,
      }).initialize();
    }
    async function server() {
      child = spawn(
        process.execPath,
        ['-r', 'ts-node/register', 'test/support/recovery-s4-server.ts'],
        {
          env: {
            ...process.env,
            POS_IGNORE_ENV_FILE: '1',
            DATABASE_USER: 'recovery_s4_runtime',
            DATABASE_PASSWORD: 'isolated_fixture',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let log = '';
      url = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(log)), 25000);
        child.stdout!.on('data', (d) => {
          log += d;
          if (process.env.RECOVERY_DEBUG) process.stderr.write(d);
          const m = /RECOVERY_READY (http:\/\/[^\s]+)/.exec(log);
          if (m) {
            clearTimeout(t);
            resolve(m[1]);
          }
        });
        child.stderr!.on('data', (d) => {
          log += d;
          if (process.env.RECOVERY_DEBUG) process.stderr.write(d);
        });
        child.once('exit', () => {
          clearTimeout(t);
          reject(new Error(log));
        });
      });
    }
    async function stop() {
      if (child && child.exitCode === null && !child.signalCode) {
        const p = once(child, 'exit');
        child.kill('SIGTERM');
        await p;
      }
    }
    const headers = () => ({
      'X-POS-Protocol': '1',
      'X-POS-Server': state.server_instance_id,
      'X-POS-Generation': state.generation_id,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    });
    async function request(
      path: string,
      body?: any,
      extra: any = {},
      method = body === undefined ? 'GET' : 'POST',
    ) {
      const r = await fetch(url + path, {
        method,
        headers: { ...headers(), ...extra },
        body:
          body === undefined
            ? undefined
            : Buffer.isBuffer(body)
              ? body
              : JSON.stringify(body),
      });
      const bytes = Buffer.from(await r.arrayBuffer());
      let value: any;
      try {
        value = JSON.parse(bytes.toString());
      } catch {
        value = bytes;
      }

      return { status: r.status, body: value, bytes };
    }
    async function prepare(
      mutate?: (m: any, chunks: Buffer[]) => void,
      start = true,
    ) {
      manifest = JSON.parse(JSON.stringify(sourceManifest));
      manifest.package_id = randomUUID();
      chunks = sourceChunks.map(Buffer.from);
      mutate?.(manifest, chunks);
      manifest.chunks.forEach((c: any, i: number) => {
        c.bytes = chunks[i].length;
        c.rows = chunks[i].toString().trimEnd().split('\n').length;
        c.sha256 = sha256(chunks[i]);
      });
      digest = sha256(canonical(manifest));
      id = randomUUID();
      token = await db.transaction((m) =>
        new RecoveryAuthorizationService().grant(m, {
          recovery_id: id,
          package_id: manifest.package_id,
          manifest_digest: digest,
          source_device_id: manifest.source.device_id,
          issuer: 'fixture-admin',
          recipient: 'fixture-operator',
        }),
      );
      if (!start) return;
      expect(
        (
          await request(
            '/recovery/sessions',
            Buffer.from(canonical(manifest)),
            {
              'Idempotency-Key': manifest.package_id,
              'X-Manifest-Sha256': digest,
            },
          )
        ).status,
      ).toBe(201);
    }
    async function upload(skip = -1) {
      for (const c of manifest.chunks)
        if (c.index !== skip) {
          const r = await request(
            `/recovery/sessions/${id}/chunks/${c.index}`,
            chunks[c.index],
            {
              'Content-Type': 'application/x-ndjson',
              'X-Chunk-Sha256': c.sha256,
            },
            'PUT',
          );
          expect(r.status).toBe(201);
        }
    }
    const progress = () => request(`/recovery/sessions/${id}`);
    const validate = async () =>
      request(`/recovery/sessions/${id}/validate`, {
        protocol_version: 1,
        manifest_digest: digest,
        expected_revision: (await progress()).body.revision,
      });
    const finalize = (v: any) =>
      request(`/recovery/sessions/${id}/finalize`, {
        protocol_version: 1,
        validation_digest: v.validation_digest,
        expected_revision: v.revision,
      });
    beforeAll(async () => {
      if (
        process.env.DATABASE_HOST !== '127.0.0.1' ||
        process.env.DATABASE_PORT !== '55484' ||
        process.env.DATABASE_NAME !== 'pos_nest_test_recovery_s4'
      )
        throw new Error('Dedicated S4 cluster required');
      await connect();
      const [identity] = await db.query(
        "SELECT current_database() AS database,current_setting('data_directory') AS directory",
      );
      expect(identity).toEqual({
        database: 'pos_nest_test_recovery_s4',
        directory: '/tmp/pos-recovery-s4-pg',
      });
      await db.query('DROP SCHEMA public CASCADE');
      await db.query('CREATE SCHEMA public');
      await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      await db.synchronize();
      const q = db.createQueryRunner();
      await q.startTransaction();
      try {
        await new CreateRecoveryProtocol1794096000000().up(q);
        await new CreateRecoveryDataset1794182400000().up(q);
        await new CreateConnectionAttempts1794355200000().up(q);
        await q.commitTransaction();
      } catch (e) {
        await q.rollbackTransaction();
        throw e;
      } finally {
        await q.release();
      }
      await db.query(
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='recovery_s4_runtime') THEN CREATE ROLE recovery_s4_runtime LOGIN PASSWORD 'isolated_fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$",
      );
      await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await db.query('GRANT USAGE ON SCHEMA public TO recovery_s4_runtime');
      await db.query(
        'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO recovery_s4_runtime',
      );
      await db.query(
        'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO recovery_s4_runtime',
      );
      await db.query(
        'GRANT UPDATE ON SEQUENCE events_server_sequence_seq TO recovery_s4_runtime',
      );
      await server();
    }, 60000);
    afterAll(async () => {
      await stop();
      if (db?.isInitialized) await db.destroy();
    }, 30000);
    async function resetDestination() {
      await db.query(
        "UPDATE server_state SET mode='empty',generation_id=uuid_generate_v4(),active_recovery_id=null,dataset_id=null,baseline_high_watermark=0,recovery_enabled=true",
      );
      await db.query(
        'TRUNCATE recovery_bootstrap_grants,recovery_dataset_chunks,recovery_datasets,recovery_rows,recovery_chunks,recovery_authorizations,recovery_audit,sync_bindings,recovery_sessions,recovery_connection_requests CASCADE',
      );
      for (const table of BUSINESS_TABLES)
        await db.query(`TRUNCATE "${table}" CASCADE`);
      await new InventoryUnitSeedService(db).onApplicationBootstrap();
      [state] = await db.query('SELECT * FROM server_state');
    }
    beforeEach(resetDestination);
    test('complete authored commercial baseline validates and publishes atomically', async () => {
      const commercial = await authorCommercialRecoveryFixture(
        db,
        sourceManifest,
        process.env.POS_RECOVERY_S6 === '1'
          ? Number(process.env.POS_RECOVERY_S6_SUPPLIERS ?? 0)
          : 0,
      );
      await resetDestination();
      await prepare((m, cs) => {
        Object.assign(m, commercial.manifest);
        cs.splice(0, cs.length, ...commercial.chunks);
      });
      await upload();
      const v = (await validate()).body;
      expect(v).toMatchObject({
        state: 'ready_to_commit',
        diagnostic: { valid: true },
      });
      expect((await db.query('SELECT count(*)::int n FROM sales'))[0].n).toBe(
        0,
      );
      const f = await finalize(v);
      expect(f).toMatchObject({ status: 200, body: { state: 'completed' } });
      expect((await db.query('SELECT count(*)::int n FROM sales'))[0].n).toBe(
        5,
      );
      expect((await finalize(v)).body.receipt).toEqual(f.body.receipt);
      const grant = await db.transaction((m) =>
        BaselineBootstrapService.grant(m, 'fixture-admin', 'Commercial-C'),
      );
      const opponent = await db.transaction((m) =>
        BaselineBootstrapService.grant(
          m,
          'fixture-admin',
          'Competing-fixture-D',
        ),
      );
      const dir = mkdtempSync('/tmp/pos-recovery-s4-commercial-'),
        input = join(dir, 'private-input.json');
      writeFileSync(
        input,
        JSON.stringify({
          ...grant,
          url,
          digest: f.body.receipt.bootstrap_digest,
          ids: commercial.ids,
          counts: commercial.counts,
          opponent_token: opponent.token,
          h: manifest.baseline_high_watermark,
        }),
        { mode: 0o600 },
      );
      try {
        const worker = await promisify(execFile)(
          'flutter',
          [
            'test',
            '--no-pub',
            'test/support/recovery_commercial_http_worker.dart',
            '--reporter',
            'expanded',
          ],
          {
            cwd: '/Users/benjamin/Projects/POS/pos_flutter',
            env: { ...process.env, POS_RECOVERY_S4_BOOTSTRAP: input },
            timeout: 80000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        writeFileSync(
          '/tmp/pos-recovery-commercial-flutter.log',
          worker.stdout + worker.stderr,
        );
        expect(worker.stdout).toContain('All tests passed!');
        expect((await db.query('SELECT count(*)::int n FROM sales'))[0].n).toBe(
          6,
        );
        const roundtrip = readFileSync(join(dir, 'roundtrip-path.txt'), 'utf8');
        const nextManifest = JSON.parse(
          readFileSync(join(roundtrip, 'manifest.json'), 'utf8'),
        );
        const nextChunks = nextManifest.chunks.map((c: any) =>
          readFileSync(join(roundtrip, c.file)),
        );
        if (process.env.POS_RECOVERY_S6 === '1') {
          await resetDestination();
          await runRecoveryS6Rehearsal(
            db,
            url,
            join(dir, 'source-prepared.json'),
          );
        }
        for (const [entity, field] of [
          ['sale_adjustment_evidence', 'version'],
          ['sale_adjustment_evidence', 'amount_minor'],
          ['sale_adjustment_evidence', 'commercial_active'],
          ['sale_delivery_incidents', 'version'],
          ['sale_delivery_incidents', 'blocked_by_event_id'],
        ]) {
          await resetDestination();
          await prepare((m, cs) => {
            Object.assign(m, JSON.parse(JSON.stringify(nextManifest)));
            cs.splice(0, cs.length, ...nextChunks.map(Buffer.from));
            const index = m.chunks.findIndex((c: any) => c.entity === entity);
            const rows = cs[index]
              .toString()
              .trimEnd()
              .split('\n')
              .map((line) => JSON.parse(line));
            rows[0].row[field] =
              field === 'version'
                ? 2
                : field === 'commercial_active'
                  ? true
                  : field === 'blocked_by_event_id'
                    ? randomUUID()
                    : String(BigInt(rows[0].row[field]) + 1n);
            cs[index] = Buffer.from(
              rows.map((row) => canonical(row)).join('\n') + '\n',
            );
          });
          await upload();
          const rejected = (await validate()).body;
          expect(rejected).toMatchObject({
            state: 'failed_validation',
            diagnostic: { valid: false },
          });
          expect(
            (await db.query('SELECT count(*)::int n FROM sales'))[0].n,
          ).toBe(0);
          expect((await finalize(rejected)).status).toBe(409);
        }
        await resetDestination();
        await prepare((m, cs) => {
          Object.assign(m, nextManifest);
          cs.splice(0, cs.length, ...nextChunks);
        });
        await upload();
        const verified = (await validate()).body;
        expect(verified).toMatchObject({
          state: 'ready_to_commit',
          diagnostic: { valid: true },
        });
        const published = (await finalize(verified)).body;
        expect(published.state).toBe('completed');
        expect((await db.query('SELECT count(*)::int n FROM sales'))[0].n).toBe(
          6,
        );
        const enrollment = await db.transaction((m) =>
          BaselineBootstrapService.grant(m, 'fixture-admin', 'Original-source'),
        );
        const writerEnrollment = await db.transaction((m) =>
          BaselineBootstrapService.grant(
            m,
            'fixture-admin',
            'Post-baseline-writer',
          ),
        );
        const writerBinding = (
          await request(
            '/sync/bindings',
            {
              protocol_version: 1,
              dataset_id: published.receipt.dataset_id,
              bootstrap_digest: published.receipt.bootstrap_digest,
            },
            {
              'X-POS-Protocol': '2',
              Authorization: 'Bearer ' + writerEnrollment.token,
            },
          )
        ).body;
        writeFileSync(
          input,
          JSON.stringify({
            url,
            token: enrollment.token,
            receipt: published.receipt,
            writer_binding: writerBinding,
          }),
          { mode: 0o600 },
        );
        try {
          const bound = await promisify(execFile)(
            'flutter',
            [
              'test',
              '--no-pub',
              'test/support/recovery_source_binding_http_worker.dart',
              '--reporter',
              'expanded',
            ],
            {
              cwd: '/Users/benjamin/Projects/POS/pos_flutter',
              env: { ...process.env, POS_RECOVERY_S5_BINDING: input },
              timeout: 120000,
              maxBuffer: 4 * 1024 * 1024,
            },
          );
          writeFileSync(
            '/tmp/pos-recovery-source-binding.log',
            bound.stdout + bound.stderr,
          );
          expect(bound.stdout).toContain('All tests passed!');
        } catch (error) {
          writeFileSync(
            '/tmp/pos-recovery-source-binding.log',
            String((error as any).stdout) + String((error as any).stderr),
          );
          throw error;
        }
        for (const phase of ['before', 'after']) {
          writeFileSync(
            input,
            JSON.stringify({
              url,
              token: enrollment.token,
              receipt: published.receipt,
              crash_phase: phase,
            }),
            { mode: 0o600 },
          );
          let killed = false;
          try {
            await promisify(execFile)(
              'flutter',
              [
                'test',
                '--no-pub',
                'test/support/recovery_source_binding_crash_worker.dart',
                '--reporter',
                'expanded',
              ],
              {
                cwd: '/Users/benjamin/Projects/POS/pos_flutter',
                env: {
                  ...process.env,
                  POS_RECOVERY_S5_BINDING: input,
                  POS_RECOVERY_S5_CRASH_MODE: 'crash',
                },
                timeout: 60000,
                maxBuffer: 4 * 1024 * 1024,
              },
            );
          } catch (error) {
            killed = true;
            writeFileSync(
              '/tmp/pos-recovery-source-killed-' + phase + '.log',
              String((error as any).stdout) + String((error as any).stderr),
            );
          }
          expect(killed).toBe(true);
          expect(
            JSON.parse(
              readFileSync(join(dir, 'killed-' + phase + '.json'), 'utf8'),
            ).phase,
          ).toBe(phase);
          try {
            const recovered = await promisify(execFile)(
              'flutter',
              [
                'test',
                '--no-pub',
                'test/support/recovery_source_binding_crash_worker.dart',
                '--reporter',
                'expanded',
              ],
              {
                cwd: '/Users/benjamin/Projects/POS/pos_flutter',
                env: {
                  ...process.env,
                  POS_RECOVERY_S5_BINDING: input,
                  POS_RECOVERY_S5_CRASH_MODE: 'recover',
                },
                timeout: 60000,
                maxBuffer: 4 * 1024 * 1024,
              },
            );
            writeFileSync(
              '/tmp/pos-recovery-source-restarted-' + phase + '.log',
              recovered.stdout + recovered.stderr,
            );
            expect(recovered.stdout).toContain('All tests passed!');
          } catch (error) {
            writeFileSync(
              '/tmp/pos-recovery-source-restarted-' + phase + '.log',
              String((error as any).stdout) + String((error as any).stderr),
            );
            throw error;
          }
        }
      } catch (error) {
        writeFileSync(
          '/tmp/pos-recovery-commercial-flutter.log',
          String((error as any).stdout) + String((error as any).stderr),
        );
        throw error;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 240000);
    test.each(['start', 'chunk', 'validate', 'finalize', 'abort'])(
      'S5 durable Flutter transfer handles %s and queries the durable result',
      async (phase) => {
        const commercial = await authorCommercialRecoveryFixture(
          db,
          sourceManifest,
        );
        await resetDestination();
        await prepare((m, cs) => {
          Object.assign(m, commercial.manifest);
          cs.splice(0, cs.length, ...commercial.chunks);
        }, false);
        const dir = mkdtempSync('/tmp/pos-recovery-s4-transfer-');
        const packageDirectory = join(dir, 'package');
        require('node:fs').mkdirSync(packageDirectory);
        writeFileSync(
          join(packageDirectory, 'manifest.json'),
          canonical(manifest),
        );
        manifest.chunks.forEach((c: any) =>
          writeFileSync(join(packageDirectory, c.file), chunks[c.index]),
        );
        const input = join(dir, 'private-input.json');
        writeFileSync(
          input,
          JSON.stringify({
            url,
            server: state.server_instance_id,
            generation: state.generation_id,
            token,
            package: packageDirectory,
            phase,
          }),
          { mode: 0o600 },
        );
        try {
          const worker = await promisify(execFile)(
            'flutter',
            [
              'test',
              '--no-pub',
              'test/support/recovery_transfer_http_worker.dart',
              '--reporter',
              'expanded',
            ],
            {
              cwd: '/Users/benjamin/Projects/POS/pos_flutter',
              env: { ...process.env, POS_RECOVERY_S5_TRANSFER: input },
              timeout: 80000,
              maxBuffer: 4 * 1024 * 1024,
            },
          );
          writeFileSync(
            '/tmp/pos-recovery-transfer-' + phase + '.log',
            worker.stdout + worker.stderr,
          );
          expect(worker.stdout).toContain('All tests passed!');
          expect(
            (await db.query('SELECT count(*)::int n FROM sales'))[0].n,
          ).toBe(phase === 'abort' ? 0 : 5);
          expect(
            (
              await db.query(
                "SELECT count(*)::int n FROM recovery_audit WHERE action='completed'",
              )
            )[0].n,
          ).toBe(phase === 'abort' ? 0 : 1);
        } catch (error) {
          writeFileSync(
            '/tmp/pos-recovery-transfer-' + phase + '.log',
            String((error as any).stdout) + String((error as any).stderr),
          );
          throw error;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      120000,
    );
    test.each([
      ['sales', 'total_minor'],
      ['sale_items', 'total_minor'],
      ['sale_payments', 'amount_minor'],
      ['credit_sales', 'amount_minor'],
      ['credit_allocations', 'amount_minor'],
      ['inventory_balances', 'version'],
      ['sale_adjustment_lines', 'amount_minor'],
      ['sale_credit_reductions', 'amount_minor'],
      ['cash_sessions', 'expected_minor'],
      ['cash_movements', 'amount_minor'],
      ['sale_reconciliation_effects', 'delta'],
      ['product_variants', 'sale_price_minor'],
      ['recipe_components', 'quantity_atomic'],
      ['variant_suppliers', 'quoted_price_minor'],
      ['variant_inventory_memory', 'source_server_sequence'],
      ['events', 'missing_configuration'],
      ['inventory_movements', 'missing_movement'],
      ['customer_payments', 'missing_payment'],
    ])(
      'commercial corruption %s.%s cannot expose partial business data',
      async (table, field) => {
        const commercial = await authorCommercialRecoveryFixture(
          db,
          sourceManifest,
        );
        await resetDestination();
        await prepare((m, cs) => {
          Object.assign(m, commercial.manifest);
          cs.splice(0, cs.length, ...commercial.chunks);
          const index = m.chunks.findIndex((c: any) => c.entity === table);
          const entries = cs[index]
            .toString()
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line));
          if (field === 'missing_configuration') {
            const at = entries.findIndex(
              (e) => e.row.event_type === 'producto_creado',
            );
            entries.splice(at, 1);
          } else if (field.startsWith('missing_')) entries.splice(0, 1);
          else
            entries[0].row[field] =
              typeof entries[0].row[field] === 'number'
                ? entries[0].row[field] + 1
                : String(BigInt(entries[0].row[field]) + 1n);
          if (entries.length)
            cs[index] = Buffer.from(
              entries.map((e) => canonical(e)).join('\n') + '\n',
            );
          else {
            cs.splice(index, 1);
            m.chunks.splice(index, 1);
            m.chunks.forEach((c: any, i: number) => {
              c.index = i;
              c.file = String(i).padStart(6, '0') + '-' + c.entity + '.ndjson';
            });
          }
        });
        await upload();
        const v = (await validate()).body;
        expect(v).toMatchObject({
          state: 'failed_validation',
          diagnostic: { valid: false },
        });
        expect((await finalize(v)).status).toBe(409);
        for (const table of [
          'sales',
          'inventory_movements',
          'sale_adjustments',
          'sale_reconciliation_effects',
          'cash_sessions',
          'customer_payments',
        ])
          expect(
            (await db.query(`SELECT count(*)::int n FROM "${table}"`))[0].n,
          ).toBe(0);
      },
      30000,
    );
    test('valid S3 package, idempotent validation/finalize, restart and lost response; new event sequence > H; post-publication abort rejected', async () => {
      await prepare();
      await upload();
      const v = (await validate()).body;
      expect(v.state).toBe('ready_to_commit');
      expect(v.diagnostic.valid).toBe(true);
      expect(
        (await db.query('SELECT count(*)::int AS n FROM suppliers'))[0].n,
      ).toBe(0);
      expect((await db.query('SELECT mode FROM server_state'))[0].mode).toBe(
        'recovering',
      );
      expect((await validate()).body.validation_digest).toBe(
        v.validation_digest,
      );
      const f = await finalize(v);
      expect(f.status).toBe(200);
      expect(f.body.state).toBe('completed');
      expect((await finalize(v)).body.receipt).toEqual(f.body.receipt);
      await stop();
      await server();
      expect((await progress()).body.receipt).toEqual(f.body.receipt);
      expect(
        (
          await request(`/recovery/sessions/${id}/abort`, {
            protocol_version: 1,
            expected_revision: f.body.revision,
            reason: 'after publication',
          })
        ).status,
      ).toBe(409);
      await db.query(
        "UPDATE recovery_authorizations SET expires_at=now()-interval '1 second' WHERE recovery_id=$1",
        [id],
      );
      expect((await progress()).status).toBe(403);
      await db.query('UPDATE server_state SET recovery_enabled=false');
      token = await db.transaction((m) =>
        new RecoveryAuthorizationService().grant(m, {
          recovery_id: id,
          package_id: manifest.package_id,
          manifest_digest: digest,
          source_device_id: manifest.source.device_id,
          issuer: 'fixture-admin',
          recipient: 'receipt-reader',
        }),
      );
      expect((await progress()).body.receipt).toEqual(f.body.receipt);
      expect((await finalize(v)).body.receipt).toEqual(f.body.receipt);
      const [event] = await db.query(
        "INSERT INTO events(event_id,aggregate_type,aggregate_id,event_type,device_id,user_id,created_at_local,payload,sync_status) VALUES($1,'supplier',$2,'fixture','new-device','fixture',now(),'{}','synced') RETURNING server_sequence",
        [randomUUID(), randomUUID()],
      );
      expect(BigInt(event.server_sequence)).toBeGreaterThan(99n);
      expect(
        (
          await request(`/recovery/sessions/${id}/abort`, {
            protocol_version: 1,
            expected_revision: f.body.revision,
            reason: 'too late',
          })
        ).status,
      ).toBe(403);
      expect(
        (await db.query('SELECT count(*)::int AS n FROM events'))[0].n,
      ).toBe(2);
    });
    test.each([
      'incomplete',
      'corrupt-storage',
      'missing-creator',
      'wrong-amount-shape',
      'unknown-contract',
      'duplicate-pk',
      'unsupported-business',
      'invalid-units',
    ])(
      '%s blocks activation durably without partial business',
      async (kind) => {
        await prepare((m, cs) => {
          if (kind === 'missing-creator') {
            const row = JSON.parse(cs[3].toString()).row;
            row.created_event_id = randomUUID();
            cs[3] = Buffer.from(canonical({ entity: 'suppliers', row }) + '\n');
          }
          if (kind === 'wrong-amount-shape') {
            const row = JSON.parse(cs[3].toString()).row;
            row.version = '1';
            cs[3] = Buffer.from(canonical({ entity: 'suppliers', row }) + '\n');
          }
          if (kind === 'unknown-contract') {
            const row = JSON.parse(cs[2].toString()).row;
            row.event_type = 'future_event';
            cs[2] = Buffer.from(canonical({ entity: 'events', row }) + '\n');
          }
          if (kind === 'duplicate-pk') {
            cs[3] = Buffer.concat([cs[3], cs[3]]);
          }
          if (kind === 'unsupported-business') {
            m.chunks[3].entity = 'sales';
            m.chunks[3].file = '000003-sales.ndjson';
            const row = JSON.parse(cs[3].toString()).row;
            cs[3] = Buffer.from(canonical({ entity: 'sales', row }) + '\n');
          }
          if (kind === 'invalid-units') {
            const rows = cs[4]
              .toString()
              .trimEnd()
              .split('\n')
              .map((x: string) => JSON.parse(x));
            rows[0].row.atomic_factor = '2';
            cs[4] = Buffer.from(rows.map(canonical).join('\n') + '\n');
          }
        });
        if (kind === 'duplicate-pk') {
          // Transport itself rejects identical rows before a validation can start.
          for (const c of manifest.chunks) {
            const r = await request(
              `/recovery/sessions/${id}/chunks/${c.index}`,
              chunks[c.index],
              {
                'Content-Type': 'application/x-ndjson',
                'X-Chunk-Sha256': c.sha256,
              },
              'PUT',
            );
            expect(r.status).toBe(c.index === 3 ? 422 : 201);
          }
        } else await upload(kind === 'incomplete' ? 3 : -1);
        if (kind === 'corrupt-storage')
          await db.query(
            "UPDATE recovery_chunks SET content=decode('00','hex') WHERE recovery_id=$1 AND chunk_index=3",
            [id],
          );
        const v = (await validate()).body;
        expect(v.state).toBe('failed_validation');
        expect(v.diagnostic.valid).toBe(false);
        expect((await validate()).body.validation_digest).toBe(
          v.validation_digest,
        );
        expect((await finalize(v)).status).toBe(409);
        expect(
          (await db.query('SELECT count(*)::int AS n FROM suppliers'))[0].n,
        ).toBe(0);
        expect(
          (
            await db.query('SELECT count(*)::int AS n FROM recovery_datasets')
          )[0].n,
        ).toBe(0);
        expect((await db.query('SELECT mode FROM server_state'))[0].mode).toBe(
          'recovering',
        );
      },
    );
    test.each(['suppliers', 'event_provenance'])(
      'omitting the entire %s chunk cannot publish an incomplete baseline',
      async (entity) => {
        await prepare((m, cs) => {
          const index = m.chunks.findIndex((c: any) => c.entity === entity);
          m.chunks.splice(index, 1);
          cs.splice(index, 1);
          m.chunks.forEach((c: any, i: number) => {
            c.index = i;
            c.file = String(i).padStart(6, '0') + '-' + c.entity + '.ndjson';
          });
        });
        await upload();
        const v = (await validate()).body;
        expect(v.state).toBe('failed_validation');
        expect(v.diagnostic.error.code).toBe(
          entity === 'suppliers'
            ? 'missing_projection'
            : 'missing_event_provenance',
        );
        expect((await finalize(v)).status).toBe(409);
        expect(
          (await db.query('SELECT count(*)::int AS n FROM events'))[0].n,
        ).toBe(0);
        expect(
          (
            await db.query('SELECT count(*)::int AS n FROM recovery_datasets')
          )[0].n,
        ).toBe(0);
      },
    );
    // A newly authored synthetic history, not a repaired copy of the incomplete
    // S1/S3 commercial harness. Every fact exists explicitly before the cut.
    async function inventoryPackage(tamper?: string) {
      let itemId = '';
      await prepare((m, cs) => {
        const rows: Record<string, any[]> = {};
        for (let i = 0; i < cs.length; i++) {
          const entity = m.chunks[i].entity;
          rows[entity] = cs[i]
            .toString()
            .trimEnd()
            .split('\n')
            .map((line: string) => JSON.parse(line).row);
        }
        itemId = randomUUID();
        const ids = Array.from({ length: 4 }, () => randomUUID());
        const firstMovement = randomUUID(),
          receipt = randomUUID(),
          reverse = randomUUID();
        const unit = rows.units.find((u: any) => u.code === 'piece').unit_id;
        const template = rows.events[0];
        const payloads = [
          {
            inventory_item: {
              inventory_item_id: itemId,
              name: 'Recurso admisible',
              default_unit_id: unit,
            },
            initial_movement: {
              movement_id: firstMovement,
              movement_type: 'initial_balance',
              quantity_delta_atomic: 10,
              reason: null,
              reversal_of_movement_id: null,
              total_cost_minor: null,
            },
          },
          {
            base_event_id: ids[0],
            movement: {
              movement_id: receipt,
              movement_type: 'stock_receipt',
              quantity_delta_atomic: 5,
              reason: null,
              reversal_of_movement_id: null,
              total_cost_minor: null,
            },
          },
          {
            base_event_id: ids[1],
            changed_fields: ['name'],
            changes: {
              name: { from: 'Recurso admisible', to: 'Nombre recuperado' },
            },
          },
          {
            base_event_id: ids[2],
            movement: {
              movement_id: reverse,
              movement_type: 'reversal',
              quantity_delta_atomic: -5,
              reason: null,
              reversal_of_movement_id: receipt,
              total_cost_minor: null,
            },
          },
        ];
        const types = [
          'recurso_inventario_creado',
          'movimiento_inventario_registrado',
          'recurso_inventario_actualizado',
          'movimiento_inventario_registrado',
        ];
        ids.forEach((eventId, i) => {
          rows.events.push({
            ...template,
            event_id: eventId,
            aggregate_id: itemId,
            aggregate_type: 'inventory_item',
            event_type: types[i],
            server_sequence: String(20 + i),
            base_version: i === 0 ? 1 : i,
            base_server_sequence: i === 0 ? null : String(19 + i),
            payload: payloads[i],
          });
          rows.event_provenance.push({
            ...rows.event_provenance[0],
            event_id: eventId,
            observed_local_sequence: String(20 + i),
          });
        });
        rows.inventory_items = [
          {
            active: true,
            version: 4,
            created_event_id: ids[0],
            last_event_id: ids[3],
            last_server_sequence: '23',
            inventory_item_id: itemId,
            default_unit_id: unit,
            name: 'Nombre recuperado',
            origin_variant_id: null,
          },
        ];
        rows.inventory_balances = [
          {
            inventory_item_id: itemId,
            quantity_on_hand_atomic: '10',
            quantity_available_atomic: '10',
            version: 3,
            last_event_id: ids[3],
            last_server_sequence: '23',
          },
        ];
        rows.inventory_movements = [0, 1, 3].map((i) => {
          const p = payloads[i] as any,
            movement = p.initial_movement ?? p.movement;
          return {
            ...movement,
            quantity_delta_atomic: String(movement.quantity_delta_atomic),
            inventory_item_id: itemId,
            sale_item_id: null,
            sale_adjustment_id: null,
            event_id: ids[i],
            created_at_local: template.created_at_local,
            server_sequence: String(20 + i),
          };
        });
        if (tamper === 'legacy-origin-null')
          (payloads[0] as any).inventory_item.origin_variant_id = null;
        if (tamper === 'unknown-payload-field')
          (payloads[0] as any).secret = null;
        if (tamper === 'balance')
          rows.inventory_balances[0].quantity_on_hand_atomic = '11';
        if (tamper === 'missing-movement')
          rows.inventory_movements.splice(0, 1);
        if (tamper === 'missing-balance') delete rows.inventory_balances;
        if (tamper === 'identity')
          rows.inventory_items[0].origin_variant_id = randomUUID();
        if (tamper === 'version') rows.inventory_items[0].version = 3;
        if (tamper === 'base')
          rows.events.find(
            (e: any) => e.event_id === ids[3],
          ).base_server_sequence = '20';
        if (tamper === 'delta')
          rows.inventory_movements.find(
            (r: any) => r.movement_id === receipt,
          ).quantity_delta_atomic = '6';
        cs.splice(0);
        m.chunks.splice(0);
        for (const entity of Object.keys(rows).sort()) {
          rows[entity].sort((a, b) =>
            canonical(RECOVERY_KEYS[entity].map((k) => a[k])).localeCompare(
              canonical(RECOVERY_KEYS[entity].map((k) => b[k])),
            ),
          );
          const index = cs.length;
          cs.push(
            Buffer.from(
              rows[entity].map((row) => canonical({ entity, row })).join('\n') +
                '\n',
            ),
          );
          m.chunks.push({
            index,
            entity,
            file: String(index).padStart(6, '0') + '-' + entity + '.ndjson',
            rows: rows[entity].length,
            bytes: 0,
            sha256: '0'.repeat(64),
          });
        }
      });
      await upload();
      return itemId;
    }
    test('inventory history materializes exact ledger, versions and deterministic complete refs without replay', async () => {
      const itemId = await inventoryPackage();
      const v = (await validate()).body;
      expect(v.state).toBe('ready_to_commit');
      expect(
        (await db.query('SELECT count(*)::int AS n FROM inventory_items'))[0].n,
      ).toBe(0);
      const f = await finalize(v);
      expect(f.body.state).toBe('completed');
      const [balance] = await db.query(
        'SELECT * FROM inventory_balances WHERE inventory_item_id=$1',
        [itemId],
      );
      expect(balance).toMatchObject({
        quantity_on_hand_atomic: '10',
        quantity_available_atomic: '10',
        version: 3,
        last_server_sequence: '23',
      });
      expect(
        (
          await db.query('SELECT count(*)::int AS n FROM inventory_movements')
        )[0].n,
      ).toBe(3);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM event_refs WHERE ref_type='inventory_movement'",
          )
        )[0].n,
      ).toBe(3);
      expect((await finalize(v)).body.receipt).toEqual(f.body.receipt);
    });
    test.each([
      'balance',
      'missing-movement',
      'missing-balance',
      'identity',
      'version',
      'base',
      'delta',
      'unknown-payload-field',
    ])('inventory %s corruption blocks atomic publication', async (tamper) => {
      await inventoryPackage(tamper);
      const v = (await validate()).body;
      expect(v.state).toBe('failed_validation');
      expect((await finalize(v)).status).toBe(409);
      expect(
        (await db.query('SELECT count(*)::int AS n FROM inventory_items'))[0].n,
      ).toBe(0);
    });
    test('documented explicit null provenance remains original evidence', async () => {
      await inventoryPackage('legacy-origin-null');
      const v = (await validate()).body;
      expect(v.state).toBe('ready_to_commit');
      expect((await finalize(v)).body.state).toBe('completed');
      const [event] = await db.query(
        "SELECT payload FROM events WHERE event_type='recurso_inventario_creado'",
      );
      expect(event.payload.inventory_item).toHaveProperty(
        'origin_variant_id',
        null,
      );
    });
    async function financialPackage(tamper?: string) {
      await prepare((m, cs) => {
        const rows: Record<string, any[]> = {};
        for (let i = 0; i < cs.length; i++)
          rows[m.chunks[i].entity] = cs[i]
            .toString()
            .trimEnd()
            .split('\n')
            .map((l: string) => JSON.parse(l).row);
        const customer = randomUUID(),
          category = randomUUID(),
          baseline = randomUUID(),
          payment = randomUUID();
        const eventIds = Array.from({ length: 5 }, () => randomUUID());
        const template = rows.events[0];
        const metadata = (i: number) => ({
          active: true,
          version: 1,
          created_event_id: eventIds[i],
          last_event_id: eventIds[i],
          last_server_sequence: String(20 + i),
        });
        const facts = [
          {
            aggregate_type: 'cliente',
            aggregate_id: customer,
            event_type: 'cliente_creado',
            payload: { nombre: 'Cliente recuperado', telefono: null },
          },
          {
            aggregate_type: 'financial_category',
            aggregate_id: category,
            event_type: 'categoria_financiera_creada',
            payload: {
              name: 'Compra documentada',
              direction: 'out',
              nature: 'operating',
            },
          },
          {
            aggregate_type: 'account_balance_baseline',
            aggregate_id: baseline,
            event_type: 'saldo_cuenta_inicial_declarado',
            payload: { amount_minor: -1000, as_of_ms: 1000 },
          },
          {
            aggregate_type: 'customer_payment',
            aggregate_id: payment,
            event_type: 'abono_cliente_registrado',
            payload: {
              cliente_id: customer,
              cliente_event_id: eventIds[0],
              amount_minor: 200,
              method: 'transfer',
              reference: null,
              currency: 'MXN',
              occurred_at_ms: 2000,
            },
          },
          {
            aggregate_type: 'financial_entry',
            aggregate_id: randomUUID(),
            event_type: 'movimiento_financiero_registrado',
            payload: {
              category_id: category,
              category_event_id: eventIds[1],
              category_name_snapshot: 'Compra documentada',
              direction: 'out',
              nature: 'operating',
              amount_minor: 300,
              currency: 'MXN',
              method: 'transfer',
              occurred_at_ms: 500,
              notes: null,
              reference: null,
            },
          },
        ];
        facts.forEach((fact, i) => {
          rows.events.push({
            ...template,
            ...fact,
            event_id: eventIds[i],
            server_sequence: String(20 + i),
            base_version: 1,
            base_server_sequence: null,
          });
          rows.event_provenance.push({
            ...rows.event_provenance[0],
            event_id: eventIds[i],
            observed_local_sequence: String(20 + i),
          });
        });
        rows.clientes = [
          {
            ...metadata(0),
            cliente_id: customer,
            nombre: 'Cliente recuperado',
            telefono: null,
          },
        ];
        rows.financial_categories = [
          { ...metadata(1), id: category, ...facts[1].payload },
        ];
        rows.account_balance_baselines = [
          {
            ...metadata(2),
            id: baseline,
            amount_minor: '-1000',
            as_of_ms: '1000',
            device_id: template.device_id,
            declared_by_user_id: template.user_id,
          },
        ];
        rows.customer_payments = [
          {
            ...metadata(3),
            id: payment,
            cliente_id: customer,
            amount_minor: '200',
            method: 'transfer',
            reference: null,
            occurred_at_ms: '2000',
          },
        ];
        const { category_event_id, ...entry } = facts[4].payload as any;
        rows.financial_entries = [
          {
            ...metadata(4),
            id: facts[4].aggregate_id,
            ...entry,
            amount_minor: '300',
            occurred_at_ms: '500',
          },
        ];
        if (tamper === 'missing-entry') delete rows.financial_entries;
        if (tamper === 'missing-category') delete rows.financial_categories;
        if (tamper === 'missing-payment') delete rows.customer_payments;
        if (tamper === 'amount') rows.customer_payments[0].amount_minor = '201';
        if (tamper === 'negative-baseline')
          rows.account_balance_baselines[0].amount_minor = '0';
        if (tamper === 'category') rows.financial_entries[0].direction = 'in';
        if (tamper === 'customer')
          rows.clientes[0].created_event_id = randomUUID();
        cs.splice(0);
        m.chunks.splice(0);
        for (const entity of Object.keys(rows).sort()) {
          rows[entity].sort((a, b) =>
            canonical(RECOVERY_KEYS[entity].map((k) => a[k])).localeCompare(
              canonical(RECOVERY_KEYS[entity].map((k) => b[k])),
            ),
          );
          const index = cs.length;
          cs.push(
            Buffer.from(
              rows[entity].map((row) => canonical({ entity, row })).join('\n') +
                '\n',
            ),
          );
          m.chunks.push({
            index,
            entity,
            file: String(index).padStart(6, '0') + '-' + entity + '.ndjson',
            rows: rows[entity].length,
            bytes: 0,
            sha256: '0'.repeat(64),
          });
        }
      });
      await upload();
    }
    test('immutable financial facts preserve negative bank baseline, its frontier, customer funds and independent expense', async () => {
      await financialPackage();
      const v = (await validate()).body;
      expect(v.state).toBe('ready_to_commit');
      expect((await finalize(v)).body.state).toBe('completed');
      expect(
        (
          await db.query(
            'SELECT amount_minor,as_of_ms FROM account_balance_baselines',
          )
        )[0],
      ).toEqual({ amount_minor: '-1000', as_of_ms: '1000' });
      expect(
        (
          await db.query(
            'SELECT amount_minor,occurred_at_ms FROM financial_entries',
          )
        )[0],
      ).toEqual({ amount_minor: '300', occurred_at_ms: '500' });
      expect(
        (await db.query('SELECT amount_minor FROM customer_payments'))[0]
          .amount_minor,
      ).toBe('200');
      expect(
        (await db.query('SELECT count(*)::int AS n FROM credit_allocations'))[0]
          .n,
      ).toBe(0);
    });
    test.each([
      'missing-entry',
      'missing-category',
      'missing-payment',
      'amount',
      'negative-baseline',
      'category',
      'customer',
    ])('financial %s corruption cannot publish', async (tamper) => {
      await financialPackage(tamper);
      const v = (await validate()).body;
      expect(v.state).toBe('failed_validation');
      expect((await finalize(v)).status).toBe(409);
      expect(
        (await db.query('SELECT count(*)::int AS n FROM customer_payments'))[0]
          .n,
      ).toBe(0);
    });
    test('publication failure rolls back business, artifact and completion; retry works', async () => {
      await prepare();
      await upload();
      const v = (await validate()).body;
      expect(v.state).toBe('ready_to_commit');
      await db.query(
        `CREATE FUNCTION fail_dataset_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected publication failure'; END $$`,
      );
      await db.query(
        'CREATE TRIGGER fail_dataset_fixture BEFORE INSERT ON recovery_dataset_chunks FOR EACH STATEMENT EXECUTE FUNCTION fail_dataset_fixture()',
      );
      try {
        expect((await finalize(v)).status).toBe(500);
        expect((await progress()).body.state).toBe('ready_to_commit');
        expect(
          (await db.query('SELECT count(*)::int AS n FROM suppliers'))[0].n,
        ).toBe(0);
        expect(
          (
            await db.query('SELECT count(*)::int AS n FROM recovery_datasets')
          )[0].n,
        ).toBe(0);
      } finally {
        await db.query(
          'DROP TRIGGER fail_dataset_fixture ON recovery_dataset_chunks',
        );
        await db.query('DROP FUNCTION fail_dataset_fixture()');
      }
      expect((await finalize(v)).body.state).toBe('completed');
    });
    test('failure after sequence reservation rolls back publication and never reduces the generator', async () => {
      await prepare();
      await upload();
      const v = (await validate()).body;
      await db.query("SELECT setval('events_server_sequence_seq',1,true)");
      await db.query(
        `CREATE FUNCTION fail_complete_s4_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='completed' THEN RAISE EXCEPTION 'injected post-sequence failure'; END IF; RETURN NEW; END $$`,
      );
      await db.query(
        'CREATE TRIGGER fail_complete_s4_fixture BEFORE INSERT ON recovery_audit FOR EACH ROW EXECUTE FUNCTION fail_complete_s4_fixture()',
      );
      try {
        expect((await finalize(v)).status).toBe(500);
        expect((await progress()).body.state).toBe('ready_to_commit');
        expect(
          (await db.query('SELECT count(*)::int AS n FROM suppliers'))[0].n,
        ).toBe(0);
        expect(
          (
            await db.query('SELECT count(*)::int AS n FROM recovery_datasets')
          )[0].n,
        ).toBe(0);
        expect(
          BigInt(
            (
              await db.query(
                'SELECT last_value FROM events_server_sequence_seq',
              )
            )[0].last_value,
          ),
        ).toBeGreaterThanOrEqual(99n);
      } finally {
        await db.query(
          'DROP TRIGGER fail_complete_s4_fixture ON recovery_audit',
        );
        await db.query('DROP FUNCTION fail_complete_s4_fixture()');
      }
      expect((await finalize(v)).body.state).toBe('completed');
      expect(
        BigInt(
          (
            await db.query('SELECT last_value FROM events_server_sequence_seq')
          )[0].last_value,
        ),
      ).toBeGreaterThanOrEqual(99n);
    });
    test('duplicate logical identity across separately valid chunks is rejected; no silent overwrite', async () => {
      await prepare((m, cs) => {
        const original = m.chunks[3];
        const index = cs.length;
        m.chunks.push({
          ...original,
          index,
          file: String(index).padStart(6, '0') + '-suppliers.ndjson',
        });
        const row = JSON.parse(cs[3].toString()).row;
        row.name = 'different duplicate';
        cs.push(Buffer.from(canonical({ entity: 'suppliers', row }) + '\n'));
      });
      await upload();
      const v = (await validate()).body;
      expect(v.state).toBe('failed_validation');
      expect(v.diagnostic.error.code).toBe('duplicate_or_unordered_key');
      expect(
        (await db.query('SELECT count(*)::int AS n FROM suppliers'))[0].n,
      ).toBe(0);
    });
    test('client catalog and absent refs are materialized with deterministic reconstructed references', async () => {
      await prepare((m, cs) => {
        const event = JSON.parse(cs[2].toString()).row;
        event.aggregate_type = 'cliente';
        event.event_type = 'cliente_creado';
        event.payload = { nombre: 'Cliente acreditado', telefono: null };
        cs[2] = Buffer.from(canonical({ entity: 'events', row: event }) + '\n');
        const row = JSON.parse(cs[3].toString()).row;
        const client = {
          active: row.active,
          version: row.version,
          created_event_id: row.created_event_id,
          last_event_id: row.last_event_id,
          last_server_sequence: row.last_server_sequence,
          cliente_id: row.supplier_id,
          nombre: 'Cliente acreditado',
          telefono: null,
        };
        m.chunks[3].entity = 'clientes';
        cs[3] = Buffer.from(
          canonical({ entity: 'clientes', row: client }) + '\n',
        );
        m.chunks.splice(1, 1);
        cs.splice(1, 1);
        m.chunks.forEach((c: any, i: number) => {
          c.index = i;
          c.file = String(i).padStart(6, '0') + '-' + c.entity + '.ndjson';
        });
      });
      await upload();
      const v = (await validate()).body;
      expect(v.state).toBe('ready_to_commit');
      const f = (await finalize(v)).body;
      expect(f.state).toBe('completed');
      expect(f.receipt.summary.clientes).toBe('1');
      expect(f.receipt.summary.event_refs).toBe('1');
      expect(
        (await db.query('SELECT ref_type,source FROM event_refs'))[0],
      ).toEqual({ ref_type: 'cliente', source: 'server' });
    });
    test.each(['recovery_rows', 'validation_trial', 'recovery_dataset_chunks'])(
      'SIGKILL during %s keeps maintenance and no partial business; restart resumes',
      async (table) => {
        const target = table === 'validation_trial' ? 'recovery_rows' : table;
        const commercial = await authorCommercialRecoveryFixture(
          db,
          sourceManifest,
        );
        await resetDestination();
        await prepare((m, cs) => {
          Object.assign(m, commercial.manifest);
          cs.splice(0, cs.length, ...commercial.chunks);
        });
        await upload();
        const v =
          table === 'recovery_dataset_chunks' ? (await validate()).body : null;
        const lock = db.createQueryRunner();
        await lock.connect();
        await lock.query('SELECT pg_advisory_lock(841904)');
        await db.query(
          `CREATE FUNCTION pause_s4_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${table === 'validation_trial' ? "IF (SELECT mode FROM server_state WHERE singleton)='active' THEN PERFORM pg_advisory_xact_lock(841904); END IF;" : 'PERFORM pg_advisory_xact_lock(841904);'} RETURN NULL; END $$`,
        );
        await db.query(
          `CREATE TRIGGER pause_s4_fixture BEFORE INSERT ON ${target} FOR EACH STATEMENT EXECUTE FUNCTION pause_s4_fixture()`,
        );
        const pending = (v ? finalize(v) : validate()).catch((e) => ({
          transport_error: true,
        }));
        try {
          let waiting = false;
          for (let i = 0; i < 200; i++) {
            const [r] = await db.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='recovery_s4_runtime' AND wait_event='advisory') AS waiting",
            );
            if (r.waiting) {
              waiting = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          expect(waiting).toBe(true);
          expect(
            (await db.query('SELECT mode FROM server_state'))[0].mode,
          ).toBe('recovering');
          expect(
            (await db.query('SELECT count(*)::int AS n FROM suppliers'))[0].n,
          ).toBe(0);
          expect(
            (
              await db.query(
                "SELECT count(*)::int AS n FROM recovery_audit WHERE action='completed'",
              )
            )[0].n,
          ).toBe(0);
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
          await lock.query('SELECT pg_advisory_unlock(841904)');
          await pending;
          // Await rollback of the dead writer before deleting only our fixture hook.
          await db.transaction((m) =>
            m.query('SELECT * FROM server_state FOR SHARE'),
          );
        } finally {
          await lock.query('SELECT pg_advisory_unlock_all()');
          await lock.release();
          await db.query(`DROP TRIGGER pause_s4_fixture ON ${target}`);
          await db.query('DROP FUNCTION pause_s4_fixture()');
        }
        await server();
        expect((await progress()).body.state).toBe(
          v ? 'ready_to_commit' : 'validating',
        );
        const ready = v ?? (await validate()).body;
        expect(ready.state).toBe('ready_to_commit');
        const results = await Promise.all([finalize(ready), finalize(ready)]);
        expect(results.map((r) => r.body.state)).toEqual([
          'completed',
          'completed',
        ]);
        expect(results[0].body.receipt).toEqual(results[1].body.receipt);
        expect(
          (await db.query('SELECT count(*)::int AS n FROM suppliers'))[0].n,
        ).toBe(1);
      },
    );
    test.each(['supplier', 'inventory', 'financial'])(
      'empty real Flutter client downloads HTTP baseline and operates on recovered %s without duplicate effects',
      async (scenario) => {
        let inventoryId: string | undefined;
        if (scenario === 'inventory') inventoryId = await inventoryPackage();
        else if (scenario === 'financial') await financialPackage();
        else {
          await prepare();
          await upload();
        }
        const v = (await validate()).body;
        const f = (await finalize(v)).body;
        expect(f.state).toBe('completed');
        const grant = await db.transaction((m) =>
          BaselineBootstrapService.grant(m, 'fixture-admin', 'Flutter-C'),
        );
        const dir = mkdtempSync('/tmp/pos-recovery-s4-http-');
        const input = join(dir, 'private-input.json');
        writeFileSync(
          input,
          JSON.stringify({
            ...grant,
            url,
            digest: f.receipt.bootstrap_digest,
            inventory_item_id: inventoryId,
            scenario,
          }),
          { mode: 0o600 },
        );
        try {
          const result = await promisify(execFile)(
            'flutter',
            [
              'test',
              '--no-pub',
              'test/support/baseline_bootstrap_http_worker.dart',
              '--reporter',
              'expanded',
            ],
            {
              cwd: '/Users/benjamin/Projects/POS/pos_flutter',
              env: { ...process.env, POS_RECOVERY_S4_BOOTSTRAP: input },
              timeout: 80000,
              maxBuffer: 4 * 1024 * 1024,
            },
          );
          writeFileSync(
            '/tmp/pos-recovery-s4-flutter-http.log',
            result.stdout + result.stderr,
          );
          expect(result.stdout).toContain('All tests passed!');
          expect(
            (await db.query('SELECT name,version FROM suppliers'))[0],
          ).toEqual(
            scenario !== 'supplier'
              ? { name: 'Proveedor acreditado', version: 1 }
              : { name: 'Proveedor editado desde C', version: 2 },
          );
          expect(
            (await db.query('SELECT count(*)::int AS n FROM events'))[0].n,
          ).toBe(
            scenario === 'financial' ? 7 : scenario === 'inventory' ? 6 : 2,
          );
          if (scenario === 'inventory') {
            expect(
              (
                await db.query(
                  'SELECT quantity_on_hand_atomic FROM inventory_balances',
                )
              )[0].quantity_on_hand_atomic,
            ).toBe('17');
            expect(
              (
                await db.query(
                  'SELECT count(*)::int AS n FROM inventory_movements',
                )
              )[0].n,
            ).toBe(4);
          }
        } catch (e) {
          writeFileSync(
            '/tmp/pos-recovery-s4-flutter-http.log',
            (e.stdout ?? '') + (e.stderr ?? ''),
          );
          throw new Error(
            'Flutter HTTP integration failed; see /tmp/pos-recovery-s4-flutter-http.log',
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      90000,
    );
    test('authenticated immutable bootstrap, separate binding and sync starts at H; legacy/incompatible rejected', async () => {
      await prepare();
      await upload();
      const v = (await validate()).body;
      const f = (await finalize(v)).body;
      const grant = await db.transaction((m) =>
        BaselineBootstrapService.grant(m, 'fixture-admin', 'empty-client-C'),
      );
      const h = {
        'X-POS-Protocol': '2',
        Authorization: 'Bearer ' + grant.token,
      };
      const d = await request('/sync/bootstrap', undefined, h);
      expect(d.status).toBe(200);
      expect(sha256(d.bytes)).toBe(f.receipt.bootstrap_digest);
      for (const c of d.body.chunks) {
        const r = await request(
          '/sync/bootstrap/chunks/' + c.index,
          undefined,
          h,
        );
        expect(r.status).toBe(200);
        expect(sha256(r.bytes)).toBe(c.sha256);
      }
      expect((await request('/sync/pull?since=0', undefined, h)).status).toBe(
        403,
      );
      const body = {
        protocol_version: 1,
        dataset_id: f.receipt.dataset_id,
        bootstrap_digest: f.receipt.bootstrap_digest,
      };
      const binding = (await request('/sync/bindings', body, h)).body;
      expect(binding.device_id).not.toBe(manifest.source.device_id);
      expect(binding.token).not.toBe(grant.token);
      expect((await request('/sync/bindings', body, h)).body).toEqual(binding);
      const bh = {
        'X-POS-Protocol': '2',
        'X-POS-Device': binding.device_id,
        Authorization: 'Bearer ' + binding.token,
      };
      expect((await request('/sync/pull?since=0', undefined, bh)).status).toBe(
        409,
      );
      const pull = await request('/sync/pull?since=99', undefined, bh);
      expect(pull.status).toBe(200);
      expect(pull.body.events).toEqual([]);
      expect(pull.body.next_cursor).toBe(99);
      expect(
        (
          await request(
            '/sync/preflight',
            {
              device_id: binding.device_id,
              last_full_pull_server_sequence: 99,
              pending_refs: [],
            },
            bh,
          )
        ).body.preflight_sequence,
      ).toBe(99);
      expect(
        (
          await request('/sync/pull?since=99', undefined, {
            ...bh,
            'X-POS-Protocol': '1',
          })
        ).status,
      ).toBe(426);
      expect(
        (
          await request('/sync/pull?since=99', undefined, {
            ...bh,
            'X-POS-Generation': randomUUID(),
          })
        ).status,
      ).toBe(409);
    });
  },
);
