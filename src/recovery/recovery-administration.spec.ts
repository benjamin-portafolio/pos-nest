import {
  createAdminPasswordHash,
  ADMIN_PASSWORD_HASH_KEY,
} from './recovery-admin-password';
import type { Server } from 'node:http';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { RecoveryAdministrationController } from './recovery-administration.controller';
import { RecoveryAdministrationService } from './recovery-administration.service';
import { RecoveryAdminGuard } from './recovery-admin.guard';
import { RecoveryEligibilityService } from './recovery-eligibility.service';
import { sha256 } from './recovery-contract';
import { configureRecoveryBodyParser } from './recovery-body-parser';

const server = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const token = 'a'.repeat(64);

describe('desktop recovery administration HTTP boundary', () => {
  let app: INestApplication;
  let state: Record<string, unknown>;
  let row: Record<string, unknown> | null;
  let session: { state: string } | null;
  let configured: string | undefined;
  let passwordHash: string | undefined;
  let validPasswordHash: string;
  const password = '  Mi contraseña de instalación 🔑:  ';
  const basic = (secret: string) =>
    'Basic ' + Buffer.from('admin:' + secret, 'utf8').toString('base64');
  beforeAll(async () => {
    validPasswordHash = await createAdminPasswordHash(password);
  });
  let httpServer: Server;
  let query: jest.Mock<
    Promise<Record<string, unknown>[]>,
    [sql: string, params?: unknown[]]
  >;
  let inspect: jest.Mock<
    Promise<{
      eligible: boolean;
      reasons: string[];
      counts?: Record<string, number>;
    }>,
    []
  >;
  beforeEach(async () => {
    configured = sha256(token);
    passwordHash = undefined;
    state = {
      server_instance_id: server,
      generation_id: generation,
      revision: 4,
      mode: 'empty',
      recovery_enabled: true,
      automatic_enrollment: false,
      dataset_id: null,
      active_recovery_id: null,
    };
    row = { request_id: id, decision: 'pending', source_device_id: 'tablet-A' };
    session = null;
    query = jest.fn((sql: string) => {
      if (sql.startsWith('SELECT * FROM server_state'))
        return Promise.resolve([{ ...state }]);
      if (sql.startsWith('SELECT * FROM recovery_connection_requests'))
        return Promise.resolve(row ? [row] : []);
      if (sql.startsWith('SELECT state FROM recovery_sessions'))
        return Promise.resolve(session ? [session] : []);
      return Promise.resolve([]);
    });
    inspect = jest
      .fn<
        Promise<{
          eligible: boolean;
          reasons: string[];
          counts?: Record<string, number>;
        }>,
        []
      >()
      .mockResolvedValue({ eligible: true, reasons: [], counts: {} });
    const module = await Test.createTestingModule({
      controllers: [RecoveryAdministrationController],
      providers: [
        RecoveryAdministrationService,
        RecoveryAdminGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === ADMIN_PASSWORD_HASH_KEY ? passwordHash : configured,
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (
              fn: (m: { query: typeof query }) => Promise<unknown>,
            ) => fn({ query }),
          },
        },
        { provide: RecoveryEligibilityService, useValue: { inspect } },
      ],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    configureRecoveryBodyParser(app);
    await app.init();
    httpServer = app.getHttpServer() as Server;
  });
  afterEach(async () => app.close());
  const headers = () => ({
    Authorization: 'Bearer ' + token,
    'X-POS-Server': server,
    'X-POS-Generation': generation,
    'X-POS-Protocol': '1',
  });
  const action = (name: string, extra = {}) => ({
    action: name,
    expected_revision: 4,
    ...extra,
  });
  const mutations = () =>
    query.mock.calls.filter(([sql]) => /^(UPDATE|INSERT)/.test(sql));

  it('fails closed without administrative configuration or with wrong/missing credentials before DB access', async () => {
    await request(httpServer).get('/recovery-admin/status').expect(401);
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set({ ...headers(), Authorization: 'Bearer ' + 'b'.repeat(64) })
      .send(action('enable'))
      .expect(401);
    configured = undefined;
    await request(httpServer)
      .get('/recovery-admin/status')
      .set(headers())
      .expect(503);
    expect(query).not.toHaveBeenCalled();
  });
  it('accepts a chosen Unicode password exactly and rejects the previous token when both are configured', async () => {
    passwordHash = validPasswordHash;
    await request(httpServer)
      .get('/recovery-admin/status')
      .set({ ...headers(), Authorization: basic(password) })
      .expect(200);
    query.mockClear();
    for (const authorization of [
      basic(password.trim()),
      basic('Incorrecta pero suficientemente larga'),
      'Bearer ' + token,
    ]) {
      await request(httpServer)
        .get('/recovery-admin/status')
        .set({ ...headers(), Authorization: authorization })
        .expect(401);
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('supports existing token credentials sent by the updated application using Basic', async () => {
    await request(httpServer)
      .get('/recovery-admin/status')
      .set({ ...headers(), Authorization: basic(token) })
      .expect(200);
  });
  it('fails closed with an invalid new hash instead of falling back to the legacy token', async () => {
    for (const invalid of ['', 'invalid', '$argon2id$v=19$broken']) {
      passwordHash = invalid;
      await request(httpServer)
        .get('/recovery-admin/status')
        .set({ ...headers(), Authorization: basic(token) })
        .expect(503);
    }
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects malformed, oversized, foreign-user and invalid UTF-8 credentials without DB access', async () => {
    passwordHash = validPasswordHash;
    const foreign =
      'Basic ' + Buffer.from('otro:' + password).toString('base64');
    for (const authorization of [
      'Basic ???',
      basic('a'.repeat(129)),
      basic('línea\nsecreta'),
      foreign,
      'Basic YWRtaW46/w==',
    ]) {
      await request(httpServer)
        .get('/recovery-admin/status')
        .set({ ...headers(), Authorization: authorization })
        .expect(401);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a non-cacheable scoped status without bearer/proof hashes', async () => {
    const response = await request(httpServer)
      .get('/recovery-admin/status')
      .set(headers())
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      revision: 4,
      server_instance_id: server,
      generation_id: generation,
    });
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(query.mock.calls[1][0]).toContain('r.generation_id=$2');
    expect(query.mock.calls[1][0]).not.toContain('proof_hash');
  });
  it('rejects a stale generation and revision without mutations', async () => {
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set({ ...headers(), 'X-POS-Generation': id })
      .send(action('enable'))
      .expect(409);
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('enable', { expected_revision: 3 }))
      .expect(409);
    expect(mutations()).toHaveLength(0);
  });
  it('does not enable recovery over occupied/incompatible data', async () => {
    inspect.mockResolvedValue({
      eligible: false,
      reasons: ['destination_not_empty'],
    });
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('enable'))
      .expect(409);
    expect(mutations()).toHaveLength(0);
  });
  it('enables and records an audit entry within the destination lock', async () => {
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('enable'))
      .expect(200, {
        protocol_version: 1,
        server_instance_id: server,
        generation_id: generation,
        revision: 5,
        action: 'enable',
      });
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(
      mutations().some(([sql]) => sql.includes('INSERT INTO recovery_audit')),
    ).toBe(true);
  });
  it('reports enrollment and toggles only that policy with audit and revision', async () => {
    state.mode = 'active';
    state.dataset_id = id;
    const response = await request(httpServer)
      .get('/recovery-admin/status')
      .set(headers())
      .expect(200);
    expect(response.body).toMatchObject({ automatic_enrollment: false });
    for (const name of ['enrollment-enable', 'enrollment-disable']) {
      query.mockClear();
      await request(httpServer)
        .post('/recovery-admin/actions')
        .set(headers())
        .send(action(name))
        .expect(200);
      expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
      expect(mutations()).toEqual(
        expect.arrayContaining([
          [
            'UPDATE server_state SET automatic_enrollment=$1 WHERE singleton',
            [name === 'enrollment-enable'],
          ],
          ['UPDATE server_state SET revision=revision+1 WHERE singleton'],
        ]),
      );
      expect(
        mutations().some(([sql]) => sql.includes('INSERT INTO recovery_audit')),
      ).toBe(true);
      expect(
        mutations().some(([sql]) =>
          /UPDATE (sync_bindings|recovery_bootstrap_grants)/.test(sql),
        ),
      ).toBe(false);
    }
  });
  it('rejects enrollment before publication, during recovery, or against stale state', async () => {
    for (const change of [
      { mode: 'empty', dataset_id: null },
      { mode: 'active', dataset_id: null },
      { mode: 'recovering', dataset_id: id },
      { mode: 'active', dataset_id: id, active_recovery_id: id },
    ]) {
      Object.assign(state, change);
      await request(httpServer)
        .post('/recovery-admin/actions')
        .set(headers())
        .send(action('enrollment-enable'))
        .expect(409);
    }
    state.mode = 'active';
    state.active_recovery_id = null;
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('enrollment-disable', { expected_revision: 3 }))
      .expect(409);
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('enrollment-enable', { request_id: id }))
      .expect(400);
    expect(mutations()).toHaveLength(0);
  });
  it('approves only a request in this generation, and records the decision and audit', async () => {
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('approve', { request_id: id }))
      .expect(200);
    const select = query.mock.calls.find(([sql]) =>
      sql.startsWith('SELECT * FROM recovery_connection_requests'),
    )!;
    expect(select[1]).toEqual([id, server, generation]);
    expect(
      query.mock.calls.some(
        ([sql, params]) =>
          sql.startsWith('UPDATE recovery_connection_requests') &&
          params?.[0] === 'approved',
      ),
    ).toBe(true);
  });
  it('rejects foreign/missing, rejected, disabled, and started requests', async () => {
    row = null;
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('approve', { request_id: id }))
      .expect(404);
    row = { decision: 'rejected' };
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('approve', { request_id: id }))
      .expect(409);
    row = { decision: 'pending' };
    state.recovery_enabled = false;
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('approve', { request_id: id }))
      .expect(409);
    state.recovery_enabled = true;
    session = { state: 'completed' };
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('reject', { request_id: id }))
      .expect(409);
    expect(mutations()).toHaveLength(0);
  });
  it('does not strand an active recovery through disable or reject', async () => {
    state.active_recovery_id = id;
    state.mode = 'recovering';
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('disable'))
      .expect(409);
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('reject', { request_id: id }))
      .expect(409);
    expect(mutations()).toHaveLength(0);
  });
  it('revokes authorizations on disable and reject', async () => {
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('disable'))
      .expect(200);
    expect(
      mutations().some(([sql]) =>
        sql.includes('UPDATE recovery_authorizations SET revoked=true'),
      ),
    ).toBe(true);
    query.mockClear();
    await request(httpServer)
      .post('/recovery-admin/actions')
      .set(headers())
      .send(action('reject', { request_id: id }))
      .expect(200);
    expect(
      mutations().some(([sql]) =>
        sql.includes('UPDATE recovery_bootstrap_grants SET revoked=true'),
      ),
    ).toBe(true);
  });
  it('rejects invalid/unexpected input without mutations', async () => {
    for (const body of [
      action('drop'),
      action('enable', { action: ['enable'] }),
      action('approve', { request_id: 'bad' }),
      action('enable', { token: 'x' }),
      action('enable', { expected_revision: -1 }),
    ]) {
      await request(httpServer)
        .post('/recovery-admin/actions')
        .set(headers())
        .send(body)
        .expect(400);
    }
    expect(mutations()).toHaveLength(0);
  });
});
