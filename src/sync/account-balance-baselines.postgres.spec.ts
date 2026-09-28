import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AccountBalanceBaselineEntity } from '../entities/account-balance-baseline.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { EventsGateway } from '../events/events.gateway';
import { SyncService } from './sync.service';
import { SyncConflictService } from './sync-conflict.service';
import { AccountBalanceBaselineEventHandler } from './account-balance-baseline-event.handler';
import { PushEventDto } from './dto/push-events.dto';
import { CreateAccountBalanceBaselines1790424000000 } from '../migrations/1790424000000-CreateAccountBalanceBaselines';
import { SaldoCuentaInicialDeclaradoPayload } from './payloads/saldo-cuenta-inicial-declarado.payload';

/**
 * El saldo declarado es un hecho único e inmutable: una sola fila, declarada una
 * vez desde cualquier terminal, sin sesión y sin tocar caja. Se exige una base
 * temporal porque estas pruebas escriben de verdad.
 */
const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('Saldo en cuenta bancaria PostgreSQL temporal', () => {
  jest.setTimeout(30000);
  let db: DataSource;
  let service: SyncService;
  const device = 'bank-test-' + randomUUID();
  beforeAll(async () => {
    if (!process.env.DATABASE_NAME?.startsWith('pos_cash_test_'))
      throw new Error(
        'Estas pruebas exigen DATABASE_NAME temporal pos_cash_test_*.',
      );
    db = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
      synchronize: true,
      entities: [__dirname + '/../entities/*.entity.ts'],
    });
    await db.initialize();
    service = new SyncService(
      db,
      { notifyEventsAvailable: jest.fn() } as unknown as EventsGateway,
      new SyncConflictService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new AccountBalanceBaselineEventHandler(new SyncConflictService()),
    );
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });
  beforeEach(async () => {
    await db.query(
      'TRUNCATE account_balance_baselines,events,event_refs,sync_conflicts,sync_conflict_participants CASCADE',
    );
  });
  function declaration(
    amountMinor: number,
    writer = device,
    baselineId: string = randomUUID(),
  ): PushEventDto {
    return {
      event_id: randomUUID(),
      aggregate_type: SaldoCuentaInicialDeclaradoPayload.aggregateType,
      aggregate_id: baselineId,
      event_type: SaldoCuentaInicialDeclaradoPayload.eventType,
      device_id: writer,
      user_id: 'bank-user',
      created_at_local: new Date().toISOString(),
      base_version: 1,
      payload: { amount_minor: amountMinor, as_of_ms: Date.now() },
    };
  }
  const push = async (e: PushEventDto) =>
    (await service.pushEvents({ device_id: e.device_id, events: [e] })).results[0];

  test('acepta la declaración y la fila queda sincronizada', async () => {
    const e = declaration(150050);
    const result = await push(e);

    expect(result.status).toBe('accepted');
    const row = await db.manager.findOneByOrFail(AccountBalanceBaselineEntity, {
      id: e.aggregate_id,
    });
    expect(row.amountMinor).toBe('150050');
    expect(row.deviceId).toBe(device);
    expect(row.declaredByUserId).toBe('bank-user');
    expect(row.lastEventId).toBe(e.event_id);
    expect(row.lastServerSequence).toBe(String(result.server_sequence));
    expect(
      (await db.manager.findOneByOrFail(EventEntity, { eventId: e.event_id }))
        .syncStatus,
    ).toBe('synced');
    // El slot único se resuelve por refId constante, no por terminal.
    const slot = await db.manager.findBy(EventRefEntity, {
      eventId: e.event_id,
      refType: 'account_balance_slot',
      relationship: 'requires_unique',
    });
    expect(slot).toHaveLength(1);
    expect(slot[0].refId).toBe('unica');
  });

  test('admite un saldo sobregirado y no lo recorta', async () => {
    const e = declaration(-25000);
    expect((await push(e)).status).toBe('accepted');
    const row = await db.manager.findOneByOrFail(AccountBalanceBaselineEntity, {
      id: e.aggregate_id,
    });
    expect(row.amountMinor).toBe('-25000');
  });

  test('la segunda declaración se conserva como conflicto y no borra la primera', async () => {
    const first = declaration(30000);
    expect((await push(first)).status).toBe('accepted');

    // Otro dispositivo, otro event_id y otro aggregate_id: el slot es global.
    const second = declaration(99000, 'bank-test-' + randomUUID());
    const result = await push(second);

    expect(result.status).toBe('conflict');
    expect(result.conflict_id).toBeTruthy();
    // La primera fila sigue intacta: el hecho declarado no se toca.
    const rows = await db.manager.find(AccountBalanceBaselineEntity);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.aggregate_id);
    expect(rows[0].amountMinor).toBe('30000');
    // Y la segunda se conserva completa, no se descarta.
    const kept = await db.manager.findOneByOrFail(EventEntity, {
      eventId: second.event_id,
    });
    expect(kept.syncStatus).toBe('conflict');
    expect(kept.payload).toEqual({ amount_minor: 99000, as_of_ms: second.payload.as_of_ms });
  });

  test('misma identidad con otro event_id también se conserva sin pisar la fila', async () => {
    const first = declaration(30000);
    expect((await push(first)).status).toBe('accepted');

    const twin = declaration(77000, device, first.aggregate_id);
    const result = await push(twin);

    expect(result.status).toBe('conflict');
    const row = await db.manager.findOneByOrFail(AccountBalanceBaselineEntity, {
      id: first.aggregate_id,
    });
    expect(row.amountMinor).toBe('30000');
    expect(row.lastEventId).toBe(first.event_id);
  });

  test('el reintento del mismo event_id se reconoce como duplicado', async () => {
    const e = declaration(30000);
    expect((await push(e)).status).toBe('accepted');

    const retry = await push({ ...e, device_id: 'bank-test-' + randomUUID() });
    expect(retry.status).toBe('duplicate');
    expect(await db.manager.count(AccountBalanceBaselineEntity)).toBe(1);
  });

  test('sobre inválido se rechaza sin guardar evento', async () => {
    const bad = { ...declaration(30000), aggregate_type: 'cash_session' };
    const result = await push(bad);

    expect(result.status).toBe('rejected');
    expect(await db.manager.count(EventEntity)).toBe(0);
    expect(await db.manager.count(AccountBalanceBaselineEntity)).toBe(0);
  });

  test('una declaración con dependencia ausente se conserva como pendiente', async () => {
    // El payload real no declara dependencias (el hecho no tiene predecesor
    // causal), así que la ruta `pending` no tiene a qué entrar por el contrato.
    // Se ejerce igual para fijar su garantía: sin dependencia satisfecha el
    // evento NO se borra, queda `pending` y no se escribe fila ni referencia.
    const spy = jest
      .spyOn(
        SaldoCuentaInicialDeclaradoPayload.prototype,
        'dependencyEventIds',
        'get',
      )
      .mockReturnValue([randomUUID()]);
    try {
      const e = declaration(30000);
      const result = await push(e);

      expect(result.status).toBe('pending');
      expect(result.server_sequence).toBeNull();
      expect(await db.manager.count(EventEntity)).toBe(0);
      expect(await db.manager.count(AccountBalanceBaselineEntity)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('migración aditiva y down protegido en esquema temporal', async () => {
    const r = db.createQueryRunner();
    await r.connect();
    await r.startTransaction();
    try {
      await r.query('CREATE SCHEMA bank_migration_temp');
      await r.query('SET LOCAL search_path TO bank_migration_temp');
      const migration = new CreateAccountBalanceBaselines1790424000000();
      await migration.up(r);
      await r.query(
        "INSERT INTO account_balance_baselines(id,device_id,declared_by_user_id,amount_minor,as_of_ms) VALUES ($1,'device','user',-500,1)",
        [randomUUID()],
      );
      await expect(migration.down(r)).rejects.toThrow('historial');
      await r.query('DELETE FROM account_balance_baselines');
      await migration.down(r);
    } finally {
      await r.rollbackTransaction();
      await r.release();
    }
  });
});
