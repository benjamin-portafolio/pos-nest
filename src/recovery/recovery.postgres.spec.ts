import { CreateConnectionAttempts1794355200000 } from '../migrations/1794355200000-CreateConnectionAttempts';
import { CreateRecoveryDataset1794182400000 } from '../migrations/1794182400000-CreateRecoveryDataset';
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { DataSource } from 'typeorm';
import { CreateRecoveryProtocol1794096000000 } from '../migrations/1794096000000-CreateRecoveryProtocol';
import { RecoveryAuthorizationService } from './recovery-authorization.service';
import { BUSINESS_TABLES } from './recovery-schema';
import { canonical, sha256 } from './recovery-contract';
import { INVENTORY_UNIT_SEED } from '../inventory/inventory-unit-seed';
import { RecoveryRuntimePolicyService } from './recovery-runtime-policy.service';
import { InventoryUnitSeedService } from '../inventory/inventory-unit-seed.service';
const integration =
  process.env.RUN_RECOVERY_POSTGRES === '1' ? describe : describe.skip;
integration(
  'S2 recovery: isolated PostgreSQL + two HTTP server processes',
  () => {
    let db: DataSource,
      first: { process: ChildProcess; url: string },
      second: typeof first;
    const migration = new CreateRecoveryProtocol1794096000000();
    const auth = new RecoveryAuthorizationService();
    let state: any,
      token: string,
      recoveryId: string,
      packageId: string,
      bytes: Buffer,
      chunk: Buffer,
      digest: string;
    const children: ChildProcess[] = [];
    async function server() {
      const child = spawn(
        process.execPath,
        ['-r', 'ts-node/register', 'test/support/recovery-server.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            DATABASE_USER: 'recovery_s2_runtime',
            DATABASE_PASSWORD: 'isolated_runtime_fixture',
            POS_IGNORE_ENV_FILE: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      let logs = '';
      return new Promise<{ process: ChildProcess; url: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('Server timeout ' + logs));
          }, 20000);
          child.stdout!.on('data', (data) => {
            logs += data;
            const m = /RECOVERY_READY (http:\/\/[^\s]+)/.exec(logs);
            if (m) {
              clearTimeout(timer);
              resolve({ process: child, url: m[1] });
            }
          });
          child.stderr!.on('data', (data) => (logs += data));
          child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error('Server exit ' + code + ' ' + logs));
          });
        },
      );
    }
    async function stop(child: ChildProcess) {
      if (child.exitCode !== null || child.signalCode) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    const headers = () => ({
      'X-POS-Protocol': '1',
      'X-POS-Server': state.server_instance_id,
      'X-POS-Generation': state.generation_id,
      Authorization: 'Bearer ' + token,
    });
    async function request(
      url: string,
      path: string,
      method = 'GET',
      body?: any,
      extra: Record<string, string> = {},
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
      const text = await r.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { response: text.slice(0, 200) };
      }
      return { status: r.status, body: parsed };
    }
    const start = (url = first.url) =>
      request(url, '/recovery/sessions', 'POST', bytes, {
        'Content-Type': 'application/json',
        'X-Manifest-Sha256': digest,
        'Idempotency-Key': packageId,
      });
    const upload = (data = chunk, hash = sha256(data)) =>
      request(
        first.url,
        `/recovery/sessions/${recoveryId}/chunks/0`,
        'PUT',
        data,
        { 'Content-Type': 'application/x-ndjson', 'X-Chunk-Sha256': hash },
      );
    async function grant() {
      token = await db.transaction((m) =>
        auth.grant(m, {
          recovery_id: recoveryId,
          package_id: packageId,
          manifest_digest: digest,
          source_device_id: 'source-A',
          issuer: 'test-admin',
          recipient: 'test-operator',
        }),
      );
    }
    async function prepare() {
      recoveryId = randomUUID();
      packageId = randomUUID();
      chunk = Buffer.from(
        canonical({
          entity: 'products',
          row: { product_id: randomUUID(), name: 'Café' },
        }) + '\n',
      );
      const manifest = {
        format: 'pos-server-recovery/1',
        package_id: packageId,
        cut_at: '2026-11-08T12:00:00.000Z',
        source: {
          mode: 'server_sync',
          device_id: 'source-A',
          server_instance_id: null,
          generation_id: null,
          identity_provenance: 'legacy_unknown',
          schema_version: 9,
          schema_fingerprint: 'a'.repeat(64),
          app_revision: 'fixture-s2',
        },
        checkpoint: {
          last_full_pull_sequence: '0',
          last_full_pull_at: '2026-11-08T12:00:00.000Z',
        },
        baseline_high_watermark: '0',
        contracts: {
          recovery: 1,
          bootstrap: 1,
          sale_adjustments: 1,
          pricing: [1, 2],
        },
        eligibility: { pending: 0, failed: 0, unresolved_incidents: 0 },
        coverage: {
          global_completeness: 'unknown',
          dependency_closure: 'unchecked',
        },
        exclusions: [],
        chunks: [
          {
            index: 0,
            entity: 'products',
            file: '000000-products.ndjson',
            rows: 1,
            bytes: chunk.length,
            sha256: sha256(chunk),
          },
        ],
      };
      bytes = Buffer.from(canonical(manifest));
      digest = sha256(bytes);
      await grant();
    }
    beforeAll(async () => {
      if (
        process.env.DATABASE_HOST !== '127.0.0.1' ||
        process.env.DATABASE_PORT !== '55482' ||
        process.env.DATABASE_NAME !== 'pos_nest_test_recovery_s2'
      )
        throw new Error('Dedicated S2 cluster required');
      db = await new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port: 55482,
        username: process.env.DATABASE_USER,
        database: process.env.DATABASE_NAME,
        entities: [__dirname + '/../entities/*.entity.ts'],
        synchronize: false,
        migrationsRun: false,
      }).initialize();
      const [identity] = await db.query(
        'SELECT current_database() AS database,inet_server_port() AS port',
      );
      expect(identity).toEqual({
        database: 'pos_nest_test_recovery_s2',
        port: 55482,
      });
      // Only this new, explicitly named fixture database is reset; never uses .env.
      await db.query('DROP SCHEMA public CASCADE');
      await db.query('CREATE SCHEMA public');
      await db.query('CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\"');
      await db.synchronize(); // Existing schema fixture only; recovery DDL uses migration.
      const q = db.createQueryRunner();
      await q.startTransaction();
      try {
        await migration.up(q);
        await new CreateRecoveryDataset1794182400000().up(q);
        await new CreateConnectionAttempts1794355200000().up(q);
        await q.commitTransaction();
      } catch (e) {
        await q.rollbackTransaction();
        throw e;
      } finally {
        await q.release();
      }
      await new InventoryUnitSeedService(db).onApplicationBootstrap();
      await db.query(
        "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='recovery_s2_runtime') THEN CREATE ROLE recovery_s2_runtime LOGIN PASSWORD 'isolated_runtime_fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$",
      );
      await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await db.query('GRANT USAGE ON SCHEMA public TO recovery_s2_runtime');
      await db.query(
        'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO recovery_s2_runtime',
      );
      await db.query(
        'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO recovery_s2_runtime',
      );
      await db.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO recovery_s2_runtime',
      );
      await db.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO recovery_s2_runtime',
      );
      first = await server();
      second = await server();
    }, 60000);
    afterAll(async () => {
      await Promise.all(children.map(stop));
      if (db?.isInitialized) await db.destroy();
    }, 30000);
    beforeEach(async () => {
      // Remove only synthetic fixtures between cases. No production connection exists.
      await db.query(
        "UPDATE server_state SET mode='empty',active_recovery_id=null,dataset_id=null,baseline_high_watermark=0,recovery_enabled=true",
      );
      await db.query(
        'TRUNCATE recovery_bootstrap_grants,recovery_dataset_chunks,recovery_datasets,recovery_rows,recovery_chunks,recovery_authorizations,recovery_audit,sync_bindings,recovery_sessions',
      );
      for (const t of BUSINESS_TABLES)
        await db.query(`TRUNCATE "${t}" CASCADE`);
      await new InventoryUnitSeedService(db).onApplicationBootstrap();
      [state] = await db.query('SELECT * FROM server_state');
      await prepare();
    });
    test('R01/R02: health sequence zero is not empty, includes inactive projections, rejected events and conflicts', async () => {
      await db.query(
        'INSERT INTO products(product_id,name,active) VALUES($1,$2,false)',
        [randomUUID(), 'Zero'],
      );
      await db.query(
        `INSERT INTO events(event_id,aggregate_type,aggregate_id,event_type,device_id,user_id,created_at_local,payload,sync_status) VALUES($1,'product',$2,'fixture','d','u',now(),'{}','rejected')`,
        [randomUUID(), randomUUID()],
      );
      const health = await request(first.url, '/sync/health');
      expect(health.body.latest_server_sequence).toBe(0);
      const e = await request(first.url, '/recovery/eligibility');
      expect(e.body.counts.products).toBe(1);
      expect(e.body.counts.events).toBe(1);
      expect(e.body.eligible).toBe(false);
      expect((await start()).status).toBe(409);
      expect((await db.query('SELECT mode FROM server_state'))[0].mode).toBe(
        'empty',
      );
    });
    test('R03: exact seed allowed, missing seed allowed, altered or extra/inactive unit rejected without repair', async () => {
      expect(
        (await request(first.url, '/recovery/eligibility')).body.eligible,
      ).toBe(true);
      await db.query('UPDATE units SET name=$1 WHERE unit_id=$2', [
        'Changed',
        INVENTORY_UNIT_SEED[0].unitId,
      ]);
      await new InventoryUnitSeedService(db).onApplicationBootstrap();
      expect(
        (await request(first.url, '/recovery/eligibility')).body
          .invalid_unit_ids,
      ).toEqual([INVENTORY_UNIT_SEED[0].unitId]);
      await db.query('DELETE FROM units');
      expect(
        (await request(first.url, '/recovery/eligibility')).body.eligible,
      ).toBe(true);
      await new InventoryUnitSeedService(db).onApplicationBootstrap();
      await db.query('UPDATE units SET active=false');
      expect(
        (await request(first.url, '/recovery/eligibility')).body.eligible,
      ).toBe(false);
    });
    test('R04: unknown table or physical schema change fails closed', async () => {
      await db.query('CREATE TABLE unexpected_business(id integer)');
      try {
        expect(
          (await request(first.url, '/recovery/eligibility')).body
            .unknown_tables,
        ).toEqual(['unexpected_business']);
        expect((await start()).status).toBe(412);
      } finally {
        await db.query('DROP TABLE unexpected_business');
      }
      await db.query('ALTER TABLE products ADD COLUMN unexpected integer');
      try {
        expect((await start()).status).toBe(412);
      } finally {
        await db.query('ALTER TABLE products DROP COLUMN unexpected');
      }
    });
    test('R06: simultaneous starts in distinct Node processes reserve only one session; retry stable', async () => {
      const responses = await Promise.all([
        start(first.url),
        start(second.url),
      ]);
      expect(responses.map((r) => r.status)).toEqual([201, 201]);
      expect(responses[0].body.recovery_id).toBe(responses[1].body.recovery_id);
      expect(
        (
          await db.query('SELECT count(*)::int AS count FROM recovery_sessions')
        )[0].count,
      ).toBe(1);
      expect((await start()).body.recovery_id).toBe(recoveryId);
      const originalId = recoveryId;
      await expect(prepare()).rejects.toMatchObject({ status: 409 });
      expect(
        (await db.query('SELECT active_recovery_id FROM server_state'))[0]
          .active_recovery_id,
      ).toBe(originalId);
    });
    test('R06: two distinct authorized packages race across separate processes; only one reserves', async () => {
      const original = { token, bytes, digest, packageId, recoveryId };
      await prepare();
      const one = request(
        first.url,
        '/recovery/sessions',
        'POST',
        original.bytes,
        {
          'Content-Type': 'application/json',
          'X-Manifest-Sha256': original.digest,
          'Idempotency-Key': original.packageId,
          Authorization: 'Bearer ' + original.token,
        },
      );
      const responses = await Promise.all([one, start(second.url)]);
      expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        (
          await db.query('SELECT count(*)::int AS count FROM recovery_sessions')
        )[0].count,
      ).toBe(1);
    });
    test('R02: standalone references and resolved conflict participants still make health-0 destination nonempty', async () => {
      const eventId = randomUUID(),
        conflictId = randomUUID();
      await db.query(
        "INSERT INTO event_refs(event_ref_id,event_id,ref_type,ref_id,relationship,source) VALUES($1,$2,'fixture','zero','affects','server')",
        [randomUUID(), eventId],
      );
      await db.query(
        "INSERT INTO sync_conflicts(conflict_id,conflict_type,ref_type,ref_id) VALUES($1,'fixture','fixture','zero')",
        [conflictId],
      );
      await db.query(
        "INSERT INTO sync_conflict_participants(conflict_id,event_id,participant_role,aggregate_type,aggregate_id,event_type,sync_status) VALUES($1,$2,'contender','fixture',$3,'fixture','conflict')",
        [conflictId, eventId, randomUUID()],
      );
      expect(
        (await request(first.url, '/sync/health')).body.latest_server_sequence,
      ).toBe(0);
      const e = await request(first.url, '/recovery/eligibility');
      expect(e.body.counts).toMatchObject({
        event_refs: 1,
        sync_conflicts: 1,
        sync_conflict_participants: 1,
      });
      expect((await start()).status).toBe(409);
    });
    test('runtime SQL role cannot disable gate, bypass triggers or create unclassified tables', async () => {
      await expect(
        new RecoveryRuntimePolicyService(db).onModuleInit(),
      ).rejects.toThrow('Unsafe runtime');
      const runtime = await new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port: 55482,
        username: 'recovery_s2_runtime',
        password: 'isolated_runtime_fixture',
        database: 'pos_nest_test_recovery_s2',
      }).initialize();
      try {
        await expect(
          runtime.query(
            'ALTER TABLE products DISABLE TRIGGER recovery_business_gate',
          ),
        ).rejects.toMatchObject({ driverError: { code: '42501' } });
        await expect(
          runtime.query("SET session_replication_role='replica'"),
        ).rejects.toMatchObject({ driverError: { code: '42501' } });
        await expect(
          runtime.query('CREATE TABLE bypass_business(id integer)'),
        ).rejects.toMatchObject({ driverError: { code: '42501' } });
        await start();
        await expect(
          runtime.query('DELETE FROM sync_conflicts WHERE false'),
        ).rejects.toMatchObject({ driverError: { code: '55000' } });
      } finally {
        await runtime.destroy();
      }
    });
    test.each(['products', 'sync_conflicts'])(
      'R05/R07: in-flight %s writer wins; reservation waits and sees committed row',
      async (table) => {
        const writer = db.createQueryRunner();
        await writer.startTransaction();
        if (table === 'products')
          await writer.query(
            'INSERT INTO products(product_id,name) VALUES($1,$2)',
            [randomUUID(), 'writer first'],
          );
        else
          await writer.query(
            "INSERT INTO sync_conflicts(conflict_type,ref_type,ref_id) VALUES('fixture','fixture','writer first')",
          );
        let settled = false;
        const pending = start(second.url).then((r) => {
          settled = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(false);
        await writer.commitTransaction();
        await writer.release();
        expect((await pending).status).toBe(409);
      },
    );
    test('R05/R07: reservation wins; SQL writers on every business/conflict table and TRUNCATE are blocked', async () => {
      expect((await start()).status).toBe(201);
      for (const t of BUSINESS_TABLES) {
        await expect(
          db.query(`DELETE FROM "${t}" WHERE false`),
        ).rejects.toMatchObject({ driverError: { code: '55000' } });
        await expect(db.query(`TRUNCATE "${t}" CASCADE`)).rejects.toMatchObject(
          { driverError: { code: '55000' } },
        );
      }
      await new InventoryUnitSeedService(db).onApplicationBootstrap();
      expect(
        (await db.query('SELECT count(*)::int AS count FROM units'))[0].count,
      ).toBe(5);
    });
    test('R05/R07/R33/R34: concurrent HTTP push and conflict report cannot cross reservation', async () => {
      const modern = {
        'X-POS-Protocol': '2',
        'X-POS-Device': 'source-A',
        'Content-Type': 'application/json',
      };
      const results = await Promise.all([
        start(),
        request(
          second.url,
          '/sync/push',
          'POST',
          { device_id: 'source-A', events: [] },
          modern,
        ),
        request(
          second.url,
          '/sync/conflicts/report',
          'POST',
          { device_id: 'source-A', events: [] },
          modern,
        ),
      ]);
      expect(results[0].status).toBe(201);
      expect([409, 423]).toContain(results[1].status);
      expect([409, 423]).toContain(results[2].status);
      expect(
        (await db.query('SELECT count(*)::int AS count FROM events'))[0].count,
      ).toBe(0);
    });
    test('S6 R05: a previously admitted writer commits first; reservation observes nonempty destination', async () => {
      const writer = db.createQueryRunner();
      await writer.connect();
      await writer.startTransaction();
      let pending: Promise<any> | undefined;
      try {
        await writer.query(
          "INSERT INTO suppliers(supplier_id,name) VALUES(uuid_generate_v4(),'S6 prior writer')",
        );
        pending = start();
        let waiting = false;
        for (let i = 0; i < 200; i++) {
          const [row] = await db.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%server_state%') waiting",
          );
          if (row.waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        await writer.commitTransaction();
        expect((await pending).status).toBe(409);
        expect(
          (await db.query('SELECT count(*)::int n FROM suppliers'))[0].n,
        ).toBe(1);
        expect(
          (
            await db.query('SELECT active_recovery_id,mode FROM server_state')
          )[0],
        ).toEqual({ active_recovery_id: null, mode: 'empty' });
        expect(
          (await db.query('SELECT count(*)::int n FROM recovery_sessions'))[0]
            .n,
        ).toBe(0);
      } finally {
        if (writer.isTransactionActive) await writer.rollbackTransaction();
        await pending?.catch(() => undefined);
        await writer.release();
      }
    });
    test('R08: disabled, absent, expired, wrong operation and wrong scope credentials fail before mutation; no secret stored', async () => {
      expect(
        (
          await request(first.url, '/recovery/eligibility', 'GET', undefined, {
            Authorization: '',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(first.url, '/recovery/eligibility', 'GET', undefined, {
            'X-POS-Server': randomUUID(),
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(first.url, '/recovery/eligibility', 'GET', undefined, {
            Authorization: 'Bearer ' + 'f'.repeat(64),
          })
        ).status,
      ).toBe(403);
      await db.query('UPDATE server_state SET recovery_enabled=false');
      expect((await start()).status).toBe(403);
      await db.query('UPDATE server_state SET recovery_enabled=true');
      await db.query(
        "UPDATE recovery_authorizations SET expires_at=now()-interval '1 second'",
      );
      expect((await start()).status).toBe(403);
      await grant();
      await db.query(
        "UPDATE recovery_authorizations SET operations=ARRAY['progress'] WHERE token_hash=$1",
        [sha256(token)],
      );
      expect((await start()).status).toBe(403);
      await grant();
      await db.query(
        'UPDATE recovery_authorizations SET manifest_digest=$1 WHERE token_hash=$2',
        ['0'.repeat(64), sha256(token)],
      );
      expect((await start()).status).toBe(403);
      expect(
        JSON.stringify(await db.query('SELECT * FROM recovery_authorizations')),
      ).not.toContain(token);
      expect(
        (
          await db.query('SELECT count(*)::int AS count FROM recovery_sessions')
        )[0].count,
      ).toBe(0);
    });
    test('R09/R19: incompatible protocol/format, noncanonical manifest and invalid limits rejected', async () => {
      expect(
        (
          await request(first.url, '/recovery/eligibility', 'GET', undefined, {
            'X-POS-Protocol': '0',
          })
        ).status,
      ).toBe(412);
      const original = bytes;
      bytes = Buffer.from(original.toString() + ' ');
      digest = sha256(bytes);
      expect((await start()).status).toBe(400);
      const v = JSON.parse(original.toString());
      v.format = 'pos-server-recovery/99';
      bytes = Buffer.from(canonical(v));
      digest = sha256(bytes);
      expect((await start()).status).toBe(412);
      v.format = 'pos-server-recovery/1';
      v.chunks[0].bytes = 4194305;
      bytes = Buffer.from(canonical(v));
      digest = sha256(bytes);
      expect((await start()).status).toBe(400);
    });
    test('R17/R18: durable idempotent chunks, altered identity/content, wrong hash and extra index rejected', async () => {
      expect((await start()).status).toBe(201);
      const one = await upload();
      expect(one.status).toBe(201);
      expect(one.body.revision).toBe(1);
      const two = await upload();
      expect(two.status).toBe(200);
      expect(two.body.revision).toBe(1);
      expect((await upload(Buffer.from('changed'))).status).toBe(409);
      expect((await upload(chunk, '0'.repeat(64))).status).toBe(409);
      expect(
        (
          await request(
            first.url,
            `/recovery/sessions/${recoveryId}/chunks/1`,
            'PUT',
            chunk,
            {
              'Content-Type': 'application/x-ndjson',
              'X-Chunk-Sha256': sha256(chunk),
            },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await db.query('SELECT count(*)::int AS count FROM recovery_chunks')
        )[0].count,
      ).toBe(1);
      const p = await request(first.url, `/recovery/sessions/${recoveryId}`);
      expect(p.body.received).toHaveLength(1);
      expect(p.body.missing).toEqual([]);
    });
    test('R18/R19: corrupt first chunk never acknowledged; oversized body rejected before persistence', async () => {
      await start();
      expect((await upload(Buffer.from('changed'))).status).toBe(422);
      expect((await upload(Buffer.alloc(4194305, 97))).status).toBe(413);
      expect(
        (
          await db.query('SELECT count(*)::int AS count FROM recovery_chunks')
        )[0].count,
      ).toBe(0);
    });
    test('S4 operations require digest/revision DTOs and preserve receiving on malformed requests', async () => {
      await start();
      await upload();
      expect(
        (
          await request(
            first.url,
            `/recovery/sessions/${recoveryId}/validate`,
            'POST',
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            first.url,
            `/recovery/sessions/${recoveryId}/finalize`,
            'POST',
          )
        ).status,
      ).toBe(400);
      expect(
        (await db.query('SELECT state FROM recovery_sessions'))[0].state,
      ).toBe('receiving');
    });
    test('R20/R23: process crash, restart, resume, expired credential and renewal keep reservation; abort durable/idempotent', async () => {
      await start();
      await upload();
      const crashed = first.process;
      const exited = once(crashed, 'exit');
      crashed.kill('SIGKILL');
      await exited;
      first = await server();
      const progress = await request(
        first.url,
        `/recovery/sessions/${recoveryId}`,
      );
      expect(progress.body.state).toBe('receiving');
      expect(progress.body.received).toHaveLength(1);
      expect((await upload()).status).toBe(200);
      await db.query(
        "UPDATE recovery_authorizations SET expires_at=now()-interval '1 second'",
      );
      expect(
        (await request(first.url, `/recovery/sessions/${recoveryId}`)).status,
      ).toBe(403);
      expect((await db.query('SELECT mode FROM server_state'))[0].mode).toBe(
        'recovering',
      );
      await grant();
      expect(
        (await request(first.url, `/recovery/sessions/${recoveryId}`)).status,
      ).toBe(200);
      const path = `/recovery/sessions/${recoveryId}/abort`;
      expect(
        (
          await request(
            first.url,
            path,
            'POST',
            { protocol_version: 1, expected_revision: 0, reason: 'fixture' },
            { 'Content-Type': 'application/json' },
          )
        ).status,
      ).toBe(409);
      const body = {
        protocol_version: 1,
        expected_revision: 1,
        reason: 'fixture',
      };
      const abort = await request(first.url, path, 'POST', body, {
        'Content-Type': 'application/json',
      });
      expect(abort.body.state).toBe('aborted');
      expect(
        (
          await request(second.url, path, 'POST', body, {
            'Content-Type': 'application/json',
          })
        ).body,
      ).toMatchObject({ state: 'aborted', revision: 2 });
      expect(
        (await db.query('SELECT mode,active_recovery_id FROM server_state'))[0],
      ).toEqual({ mode: 'empty', active_recovery_id: null });
      expect(
        (
          await db.query('SELECT count(*)::int AS count FROM recovery_chunks')
        )[0].count,
      ).toBe(0);
      expect((await upload()).status).toBe(403);
    }, 30000);
    test('R20: PostgreSQL restart preserves acknowledged staging and durable maintenance mode', async () => {
      await start();
      await upload();
      const [directory] = await db.query('SHOW data_directory');
      expect(directory.data_directory).toBe('/tmp/pos-recovery-s2-pg');
      await Promise.all([stop(first.process), stop(second.process)]);
      const options = db.options;
      await db.destroy();
      execFileSync(
        '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_ctl',
        [
          '-D',
          '/tmp/pos-recovery-s2-pg',
          '-l',
          '/tmp/pos-recovery-s2-pg/server.log',
          '-m',
          'fast',
          '-w',
          'restart',
        ],
        { stdio: 'pipe' },
      );
      db = await new DataSource(options).initialize();
      first = await server();
      second = await server();
      const p = await request(first.url, `/recovery/sessions/${recoveryId}`);
      expect(p.body.state).toBe('receiving');
      expect(p.body.received).toHaveLength(1);
      expect((await db.query('SELECT mode FROM server_state'))[0].mode).toBe(
        'recovering',
      );
      expect((await upload()).status).toBe(200);
    }, 30000);
    test('R20: rollback before chunk commit leaves no acknowledged or orphan chunk', async () => {
      await start();
      const writer = db.createQueryRunner();
      await writer.startTransaction();
      await writer.query(
        'SELECT * FROM server_state WHERE singleton FOR UPDATE',
      );
      await writer.query(
        'INSERT INTO recovery_chunks(recovery_id,chunk_index,digest,content,row_count) VALUES($1,0,$2,$3,1)',
        [recoveryId, sha256(chunk), chunk],
      );
      // Explicit rollback verifies the unacknowledged transaction boundary.
      await writer.rollbackTransaction();
      await writer.release();
      const p = await request(first.url, `/recovery/sessions/${recoveryId}`);
      expect(p.body.received).toEqual([]);
      expect(p.body.missing).toEqual([0]);
      expect((await upload()).status).toBe(201);
    });
    test('R23: completed session cannot abort or downgrade even with unrevoked scope', async () => {
      await start();
      await db.query("UPDATE recovery_sessions SET state='completed'");
      expect(
        (
          await request(
            first.url,
            `/recovery/sessions/${recoveryId}/abort`,
            'POST',
            { protocol_version: 1, expected_revision: 0, reason: 'fixture' },
            { 'Content-Type': 'application/json' },
          )
        ).status,
      ).toBe(409);
      const q = db.createQueryRunner();
      await q.startTransaction();
      try {
        await expect(migration.down(q)).rejects.toThrow('downgrade');
      } finally {
        await q.rollbackTransaction();
        await q.release();
      }
    });
    test('R33/R34: legacy, wrong identity, no bootstrap/binding on every business route', async () => {
      const routes = [
        ['/SYNC/PUSH', 'POST'],
        ['/Reports/Financial?from_ms=0&to_ms=1000', 'GET'],
        ['/sync/push', 'POST'],
        ['/sync/conflicts/report', 'POST'],
        ['/sync/preflight', 'POST'],
        ['/sync/pull?since=0', 'GET'],
        ['/sync/conflicts', 'GET'],
        ['/reports/collections?from_ms=0&to_ms=1000', 'GET'],
        ['/reports/financial?from_ms=0&to_ms=1000', 'GET'],
      ];
      for (const [path, method] of routes)
        expect(
          (
            await request(
              first.url,
              path,
              method,
              method === 'POST' ? {} : undefined,
              { 'Content-Type': 'application/json', 'X-POS-Protocol': '' },
            )
          ).status,
        ).toBe(426);
      expect(
        (
          await request(first.url, '/sync/pull?since=0', 'GET', undefined, {
            'X-POS-Protocol': '2',
            'X-POS-Generation': randomUUID(),
          })
        ).status,
      ).toBe(409);
      await start();
      for (const [path, method] of routes)
        expect(
          (
            await request(
              first.url,
              path,
              method,
              method === 'POST' ? {} : undefined,
              { 'Content-Type': 'application/json', 'X-POS-Protocol': '2' },
            )
          ).status,
        ).toBe(423);
    });
    test('R34: binding is generation/dataset/device/expiry scoped and cursors never precede H or exceed watermark', async () => {
      const dataset = randomUUID(),
        binding = randomBytes(32).toString('hex');
      await db.query(
        "UPDATE server_state SET mode='active',dataset_id=$1,baseline_high_watermark=10",
        [dataset],
      );
      const modern = {
        'X-POS-Protocol': '2',
        'X-POS-Device': 'bound-device',
        Authorization: 'Bearer ' + binding,
      };
      expect(
        (
          await request(
            first.url,
            '/sync/pull?since=10',
            'GET',
            undefined,
            modern,
          )
        ).status,
      ).toBe(403);
      await db.query(
        `INSERT INTO sync_bindings(token_hash,server_instance_id,generation_id,dataset_id,device_id,bootstrap_digest,baseline_high_watermark,expires_at) VALUES($1,$2,$3,$4,'bound-device',$5,10,now()+interval '10 minutes')`,
        [
          sha256(binding),
          state.server_instance_id,
          state.generation_id,
          dataset,
          'b'.repeat(64),
        ],
      );
      expect(
        (
          await request(
            first.url,
            '/sync/pull?since=0',
            'GET',
            undefined,
            modern,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await request(
            first.url,
            '/sync/pull?since=11',
            'GET',
            undefined,
            modern,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await request(
            first.url,
            '/sync/pull?since=10',
            'GET',
            undefined,
            modern,
          )
        ).status,
      ).toBe(200);
      expect(
        (await request(first.url, '/sync/health')).body.latest_server_sequence,
      ).toBe(10);
      expect(
        (
          await request(first.url, '/sync/pull?since=10', 'GET', undefined, {
            ...modern,
            'X-POS-Device': 'other',
          })
        ).status,
      ).toBe(403);
      await db.query('UPDATE sync_bindings SET revoked=true');
      expect(
        (
          await request(
            first.url,
            '/sync/pull?since=10',
            'GET',
            undefined,
            modern,
          )
        ).status,
      ).toBe(403);
    });
    test('no partial projection or notifications, WS generic channel cannot subscribe during recovery', async () => {
      await start();
      await upload();
      expect(
        (await db.query('SELECT count(*)::int AS count FROM products'))[0]
          .count,
      ).toBe(0);
      // Engine.IO websocket transport + Socket.IO CONNECT packet; no client dependency.
      const WebSocket = require('ws');
      const ws = new WebSocket(
        first.url.replace('http:', 'ws:') +
          '/socket.io/?EIO=4&transport=websocket',
      );
      const messages: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('WS did not reject'));
        }, 3000);
        ws.on('message', (raw: any) => {
          const msg = raw.toString();
          messages.push(msg);
          if (msg.startsWith('0'))
            ws.send(
              '40' +
                JSON.stringify({
                  protocol: '2',
                  server_instance_id: state.server_instance_id,
                  generation_id: state.generation_id,
                  device_id: 'old',
                  token,
                }),
            );
        });
        ws.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once('error', reject);
      });
      expect(
        messages.some(
          (m) =>
            m.includes('sync:events_available') ||
            m.includes('messageFromServer'),
        ),
      ).toBe(false);
      expect((await db.query('SELECT mode FROM server_state'))[0].mode).toBe(
        'recovering',
      );
    });
    test('explicit up/down/up preserves seed, refuses active state and does not synchronize recovery DDL', async () => {
      await db.query('TRUNCATE recovery_authorizations');
      const units = await db.query('SELECT * FROM units ORDER BY unit_id');
      const q = db.createQueryRunner();
      await q.startTransaction();
      try {
        await new CreateRecoveryDataset1794182400000().down(q);
        await migration.down(q);
        await migration.up(q);
        await new CreateRecoveryDataset1794182400000().up(q);
        await q.commitTransaction();
      } catch (e) {
        await q.rollbackTransaction();
        throw e;
      } finally {
        await q.release();
      }
      expect(await db.query('SELECT * FROM units ORDER BY unit_id')).toEqual(
        units,
      );
      expect(
        (await db.query('SELECT recovery_enabled FROM server_state'))[0]
          .recovery_enabled,
      ).toBe(false);
    });
  },
);
