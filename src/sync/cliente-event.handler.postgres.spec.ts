import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { ClienteEntity } from '../entities/cliente.entity';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { SyncConflictParticipantEntity } from '../entities/sync-conflict-participant.entity';
import { CreateClientes1789646400000 } from '../migrations/1789646400000-CreateClientes';
import { EventsGateway } from '../events/events.gateway';
import { ClienteEventHandler } from './cliente-event.handler';
import { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';
import { PushEventDto } from './dto/push-events.dto';

const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;
integration('Clientes: PostgreSQL y sincronización en esquema aislado', () => {
  jest.setTimeout(30000);
  const schema = `clientes_it_${process.pid}_${Date.now()}`;
  let admin: DataSource, db: DataSource, service: SyncService;
  const notify = jest.fn();
  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME,
    };
    admin = new DataSource(connection);
    await admin.initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new DataSource({
      ...connection,
      schema,
      synchronize: true,
      entities: [
        ClienteEntity,
        EventEntity,
        EventRefEntity,
        SyncConflictEntity,
        SyncConflictParticipantEntity,
      ],
    });
    await db.initialize();
    const conflicts = new SyncConflictService();
    service = new SyncService(
      db,
      { notifyEventsAvailable: notify } as unknown as EventsGateway,
      conflicts,
      undefined,
      undefined,
      undefined,
      undefined,
      new ClienteEventHandler(conflicts),
    );
    // Recrea solo la tabla vacía del esquema de prueba mediante la migración real.
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}"`);
      const migration = new CreateClientes1789646400000();
      await migration.down(runner);
      await migration.up(runner);
    } finally {
      await runner.query('RESET search_path');
      await runner.release();
    }
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE "${schema}".clientes, "${schema}".events, "${schema}".event_refs,
      "${schema}".sync_conflicts, "${schema}".sync_conflict_participants CASCADE`);
    notify.mockClear();
  });
  function event(overrides: Partial<PushEventDto> = {}): PushEventDto {
    return {
      event_id: randomUUID(),
      aggregate_id: randomUUID(),
      aggregate_type: 'cliente',
      event_type: 'cliente_creado',
      device_id: 'tablet',
      user_id: 'user',
      created_at_local: new Date().toISOString(),
      base_version: 1,
      payload: { nombre: ' Ana ', telefono: ' 00123 ' },
      ...overrides,
    };
  }
  async function push(e: PushEventDto) {
    return (await service.pushEvents({ device_id: e.device_id, events: [e] }))
      .results[0];
  }
  it('push, referencia, notificación, preflight y pull comparten el contrato canónico', async () => {
    const e = event();
    const result = await push(e);
    expect(result.status).toBe('accepted');
    const row = await db.manager.findOneByOrFail(ClienteEntity, {
      id: e.aggregate_id,
    });
    expect(row).toMatchObject({
      nombre: 'Ana',
      telefono: '00123',
      version: 1,
      createdEventId: e.event_id,
      lastEventId: e.event_id,
      lastServerSequence: String(result.server_sequence),
    });
    expect(await db.manager.find(EventRefEntity)).toEqual([
      expect.objectContaining({
        refType: 'cliente',
        refId: e.aggregate_id,
        relationship: 'affects',
        source: 'server',
      }),
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ eventTypes: ['cliente_creado'] }),
    );
    const preflight = await service.preflightEvents({
      device_id: 'other-tablet',
      last_full_pull_server_sequence: 0,
      pending_refs: [
        {
          event_id: randomUUID(),
          event_type: e.event_type,
          aggregate_type: e.aggregate_type,
          aggregate_id: e.aggregate_id,
          refs: [
            { type: 'cliente', id: e.aggregate_id, relationship: 'affects' },
          ],
        },
      ],
    });
    expect(preflight.events.map((e) => e.event_id)).toEqual([e.event_id]);
    const pull = await service.pullEvents({ since: 0 });
    expect(pull.events[0].payload).toEqual({
      nombre: 'Ana',
      telefono: '00123',
    });
    expect(pull.next_cursor).toBe(result.server_sequence);
    expect((await push(e)).status).toBe('duplicate');
    expect(await db.manager.count(ClienteEntity)).toBe(1);
    expect(await db.manager.count(EventEntity)).toBe(1);
  });
  it('acepta solo nombre y permite repetir nombre y teléfono entre identidades', async () => {
    expect((await push(event({ payload: { nombre: 'Ana' } }))).status).toBe(
      'accepted',
    );
    expect(
      (await push(event({ payload: { nombre: 'Ana', telefono: '   ' } })))
        .status,
    ).toBe('accepted');
    expect((await push(event())).status).toBe('accepted');
    expect((await push(event())).status).toBe('accepted');
    expect(await db.manager.count(ClienteEntity)).toBe(4);
  });
  it.each([
    { payload: { nombre: ' ' } },
    { payload: { nombre: 'Ana', telefono: 12 } },
    { base_version: 2 },
    { base_server_sequence: 1 },
    { aggregate_type: 'otro' },
  ])(
    'rechaza entrada inválida sin proyección ni referencias %p',
    async (overrides) => {
      expect((await push(event(overrides))).status).toBe('rejected');
      expect(await db.manager.count(ClienteEntity)).toBe(0);
      expect(await db.manager.count(EventRefEntity)).toBe(0);
      expect((await service.pullEvents({ since: 0 })).events).toEqual([]);
    },
  );
  it('altas concurrentes con el mismo id conservan un ganador y registran conflicto', async () => {
    const first = event();
    const second = event({ aggregate_id: first.aggregate_id });
    const results = await Promise.all([push(first), push(second)]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'accepted',
      'conflict',
    ]);
    expect(await db.manager.count(ClienteEntity)).toBe(1);
    expect(await db.manager.count(SyncConflictEntity)).toBe(1);
    expect(await db.manager.count(SyncConflictParticipantEntity)).toBe(2);
    expect((await service.pullEvents({ since: 0 })).events).toHaveLength(1);
  });
  it('reintentos concurrentes del mismo evento son idempotentes', async () => {
    const e = event();
    const results = await Promise.all([push(e), push(e)]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'accepted',
      'duplicate',
    ]);
    expect(await db.manager.count(ClienteEntity)).toBe(1);
  });
  it('acepta el reporte del conflicto detectado por preflight en otro dispositivo', async () => {
    const winner = event();
    await push(winner);
    const loser = event({ aggregate_id: winner.aggregate_id });
    const result = await service.reportConflicts({
      device_id: 'tablet',
      events: [
        {
          ...loser,
          reason: 'Identidad ocupada',
          refs: [
            {
              type: 'cliente',
              id: loser.aggregate_id,
              relationship: 'affects',
            },
          ],
        },
      ],
    });
    expect(result.results[0].status).toBe('conflict');
    expect(
      (
        await db.manager.findOneByOrFail(ClienteEntity, {
          id: winner.aggregate_id,
        })
      ).createdEventId,
    ).toBe(winner.event_id);
  });
  it('la migración no permite retirar una tabla con clientes', async () => {
    await push(event());
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await runner.query(`SET search_path TO "${schema}"`);
      await expect(
        new CreateClientes1789646400000().down(runner),
      ).rejects.toThrow('clientes registrados');
    } finally {
      await runner.query('RESET search_path');
      await runner.release();
    }
  });
});
