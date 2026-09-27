import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { EventEntity } from '../entities/event.entity';
import { EventRefEntity } from '../entities/event-ref.entity';
import { FinancialCategoryEntity } from '../entities/financial-category.entity';
import { FinancialEntryEntity } from '../entities/financial-entry.entity';
import { SyncConflictEntity } from '../entities/sync-conflict.entity';
import { SyncConflictParticipantEntity } from '../entities/sync-conflict-participant.entity';
import { EventSyncStatus } from '../enums/event-sync-status.enum';
import { EventsGateway } from '../events/events.gateway';
import { FinancialReportService } from '../reports/financial-report.service';
import { readFinancialFixture } from '../testing/financial-fixtures';
import type { PushEventDto } from './dto/push-events.dto';
import { FinancialCategoryEventHandler } from './financial-category-event.handler';
import { FinancialEntryEventHandler } from './financial-entry-event.handler';
import { SyncConflictService } from './sync-conflict.service';
import { SyncService } from './sync.service';

const integration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

const RENTA_ID = '11111111-1111-4111-8111-111111111111';
const RENTA_EVT = '22222222-2222-4222-8222-222222222222';
const VARIOS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VARIOS_EVT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CASH_ID = '33333333-3333-4333-8333-333333333333';
const CASH_EVT = '44444444-4444-4444-8444-444444444444';
const TRANSFER_ID = '55555555-5555-4555-8555-555555555555';
const TRANSFER_EVT = '66666666-6666-4666-8666-666666666666';
const INCOME_ID = '77777777-7777-4777-8777-777777777777';
const INCOME_EVT = '88888888-8888-4888-8888-888888888888';
const FALLBACK_DEVICE = 'dispositivo-1';
const FALLBACK_USER = 'usuario-1';
const FALLBACK_CREATED_AT = '2026-09-24T12:00:00.000Z';
const FROM_SEP = 1788220800000;
const TO_OCT = 1790812800000;

integration('Ingresos y gastos PostgreSQL aislado', () => {
  jest.setTimeout(30000);
  let admin: DataSource, db: DataSource, service: SyncService;
  const schema = `financial_it_${process.pid}_${Date.now()}`;
  const categoryHandler = new FinancialCategoryEventHandler(
    new SyncConflictService(),
  );
  const entryHandler = new FinancialEntryEventHandler(
    new SyncConflictService(),
  );

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
        EventEntity,
        EventRefEntity,
        FinancialCategoryEntity,
        FinancialEntryEntity,
        SyncConflictEntity,
        SyncConflictParticipantEntity,
      ],
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
      categoryHandler,
      entryHandler,
    );
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE "${schema}".events, "${schema}".event_refs, "${schema}".financial_categories, "${schema}".financial_entries, "${schema}".sync_conflicts, "${schema}".sync_conflict_participants CASCADE`,
    );
  });

  const push = async (e: PushEventDto) =>
    (await service.pushEvents({ device_id: e.device_id, events: [e] }))
      .results[0];

  function sobre(file: string): PushEventDto {
    return readFinancialFixture(file) as unknown as PushEventDto;
  }

  function base(
    eventId: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): PushEventDto {
    return {
      event_id: eventId,
      aggregate_type: 'financial_entry',
      aggregate_id: aggregateId,
      event_type: 'movimiento_financiero_registrado',
      device_id: FALLBACK_DEVICE,
      user_id: FALLBACK_USER,
      local_sequence: null,
      base_server_sequence: null,
      base_version: 1,
      created_at_local: FALLBACK_CREATED_AT,
      payload,
    };
  }

  function entry(options: {
    eventId: string;
    aggregateId: string;
    categoryId: string;
    categoryEventId: string;
    categoryName: string;
    direction: string;
    nature: string;
    amount: number;
    method: string;
    occurredAtMs: number;
    notes: string | null;
    reference?: string | null;
  }): PushEventDto {
    return base(options.eventId, options.aggregateId, {
      category_id: options.categoryId,
      category_event_id: options.categoryEventId,
      category_name_snapshot: options.categoryName,
      direction: options.direction,
      nature: options.nature,
      amount_minor: options.amount,
      currency: 'MXN',
      method: options.method,
      occurred_at_ms: options.occurredAtMs,
      notes: options.notes,
      reference: options.reference ?? null,
    });
  }

  async function seedRenta(): Promise<void> {
    expect(
      (await push(sobre('categoria_financiera/sobre-renta-valid.json'))).status,
    ).toBe('accepted');
  }

  async function seedDataset(): Promise<void> {
    expect(
      (await push(sobre('categoria_financiera/sobre-renta-valid.json'))).status,
    ).toBe('accepted');
    expect(
      (
        await push({
          event_id: VARIOS_EVT,
          aggregate_type: 'financial_category',
          aggregate_id: VARIOS_ID,
          event_type: 'categoria_financiera_creada',
          device_id: FALLBACK_DEVICE,
          user_id: FALLBACK_USER,
          local_sequence: 4,
          base_server_sequence: null,
          base_version: 1,
          created_at_local: FALLBACK_CREATED_AT,
          payload: {
            name: 'Ingresos varios',
            direction: 'in',
            nature: 'operating',
          },
        })
      ).status,
    ).toBe('accepted');
    for (const e of [
      entry({
        eventId: CASH_EVT,
        aggregateId: CASH_ID,
        categoryId: RENTA_ID,
        categoryEventId: RENTA_EVT,
        categoryName: 'Renta',
        direction: 'out',
        nature: 'operating',
        amount: 50000,
        method: 'cash',
        occurredAtMs: 1789041600000,
        notes: 'Renta en efectivo',
      }),
      entry({
        eventId: INCOME_EVT,
        aggregateId: INCOME_ID,
        categoryId: VARIOS_ID,
        categoryEventId: VARIOS_EVT,
        categoryName: 'Ingresos varios',
        direction: 'in',
        nature: 'operating',
        amount: 200000,
        method: 'cash',
        occurredAtMs: 1789463700000,
        notes: 'Ingreso operativo de la semana',
      }),
      entry({
        eventId: TRANSFER_EVT,
        aggregateId: TRANSFER_ID,
        categoryId: RENTA_ID,
        categoryEventId: RENTA_EVT,
        categoryName: 'Renta',
        direction: 'out',
        nature: 'operating',
        amount: 150000,
        method: 'transfer',
        occurredAtMs: 1789929000000,
        notes: 'Renta de septiembre',
        reference: 'SPEI-2026-09-20',
      }),
      entry({
        eventId: randomUUID(),
        aggregateId: randomUUID(),
        categoryId: RENTA_ID,
        categoryEventId: RENTA_EVT,
        categoryName: 'Renta',
        direction: 'out',
        nature: 'operating',
        amount: 12345,
        method: 'cash',
        occurredAtMs: TO_OCT,
        notes: 'borde en to_ms',
      }),
      entry({
        eventId: randomUUID(),
        aggregateId: randomUUID(),
        categoryId: RENTA_ID,
        categoryEventId: RENTA_EVT,
        categoryName: 'Renta',
        direction: 'out',
        nature: 'operating',
        amount: 67890,
        method: 'cash',
        occurredAtMs: FROM_SEP - 1,
        notes: 'borde antes de from_ms',
      }),
    ])
      expect((await push(e)).status).toBe('accepted');
  }

  it('acepta categoría y dos registros que comparten la categoría oficial', async () => {
    await seedRenta();
    expect(
      (await push(sobre('registro/sobre-entry-cash-valid.json'))).status,
    ).toBe('accepted');
    expect(
      (await push(sobre('registro/sobre-entry-transfer-valid.json'))).status,
    ).toBe('accepted');

    const category = await db.manager.findOneByOrFail(FinancialCategoryEntity, {
      id: RENTA_ID,
    });
    expect(category).toMatchObject({
      name: 'Renta',
      direction: 'out',
      nature: 'operating',
      active: true,
      version: 1,
      createdEventId: RENTA_EVT,
      lastEventId: RENTA_EVT,
    });
    expect(await db.manager.count(FinancialEntryEntity)).toBe(2);
    expect(await db.manager.count(EventEntity)).toBe(3);
    expect(
      await db.manager.findOneBy(EventEntity, { eventId: CASH_EVT }),
    ).toMatchObject({
      syncStatus: EventSyncStatus.SYNCED,
      aggregateType: 'financial_entry',
      aggregateId: CASH_ID,
    });
    const refs = await db.manager.find(EventRefEntity, {
      where: { eventId: CASH_EVT },
    });
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refType: 'financial_entry',
          refId: CASH_ID,
          relationship: 'affects',
          source: 'server',
        }),
        expect.objectContaining({
          refType: 'financial_category',
          refId: RENTA_ID,
          relationship: 'uses',
          source: 'server',
        }),
      ]),
    );
  });

  it('reintento duplicado conserva una sola fila y el estado original', async () => {
    await seedRenta();
    const e = sobre('registro/sobre-entry-cash-valid.json');
    expect((await push(e)).status).toBe('accepted');
    const retry = await push(e);
    expect(retry.status).toBe('duplicate');
    expect(retry.original_sync_status).toBe(EventSyncStatus.SYNCED);
    expect(await db.manager.count(FinancialEntryEntity)).toBe(1);
    const rows = await db.manager.find(FinancialEntryEntity);
    expect(rows.reduce((n, r) => n + Number(r.amountMinor), 0)).toBe(50000);
  });

  it('colisión de identidad de categoría no sobrescribe la existente', async () => {
    await seedRenta();
    const colliding = readFinancialFixture(
      'conflictos/colision-categoria-mismo-aggregate-id.json',
    ) as unknown as { evento_colision: PushEventDto };
    const result = await push(colliding.evento_colision);

    expect(result.status).toBe('conflict');
    expect(result.reason).toBe(
      'Ya existe una categoría financiera con este id.',
    );
    expect(
      (
        await db.manager.findOneByOrFail(FinancialCategoryEntity, {
          id: RENTA_ID,
        })
      ).name,
    ).toBe('Renta');
    const conflict = await db.manager.findOneByOrFail(SyncConflictEntity, {
      refType: 'financial_category',
      refId: RENTA_ID,
    });
    expect(conflict).toMatchObject({
      conflictType: 'financial_category_identity',
      defaultWinnerEventId: RENTA_EVT,
      status: 'open',
    });
  });

  it('colisión de identidad de registro conserva el monto original', async () => {
    await seedRenta();
    expect(
      (await push(sobre('registro/sobre-entry-cash-valid.json'))).status,
    ).toBe('accepted');
    const colliding = readFinancialFixture(
      'conflictos/colision-registro-mismo-aggregate-id.json',
    ) as unknown as { evento_colision: PushEventDto };
    const result = await push(colliding.evento_colision);

    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'Identidad de registro financiero ya registrada.',
    });
    expect(await db.manager.count(FinancialEntryEntity)).toBe(1);
    expect(
      (await db.manager.findOneByOrFail(FinancialEntryEntity, { id: CASH_ID }))
        .amountMinor,
    ).toBe('50000');
    const conflict = await db.manager.findOneByOrFail(SyncConflictEntity, {
      refType: 'financial_category',
      refId: RENTA_ID,
    });
    expect(conflict).toMatchObject({
      conflictType: 'financial_entry_identity',
      defaultWinnerEventId: null,
    });
  });

  it('push concurrente del mismo event_id produce accepted + duplicate', async () => {
    await seedRenta();
    const e = sobre('registro/sobre-entry-cash-valid.json');
    const results = await Promise.all([push(e), push(e)]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'accepted',
      'duplicate',
    ]);
    expect(await db.manager.count(EventEntity)).toBe(2);
    expect(await db.manager.count(FinancialEntryEntity)).toBe(1);
  });

  it('push concurrente del mismo aggregate_id produce accepted + conflicto controlado', async () => {
    await seedRenta();
    const a = sobre('registro/sobre-entry-cash-valid.json');
    const b = { ...a, event_id: randomUUID(), local_sequence: null };
    const results = await Promise.all([push(a), push(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'accepted',
      'conflict',
    ]);
    expect(await db.manager.count(FinancialEntryEntity)).toBe(1);
    expect(
      (await db.manager.findOneByOrFail(FinancialEntryEntity, { id: CASH_ID }))
        .amountMinor,
    ).toBe('50000');
  });

  it('rollback de evento, proyección y refs ante fallo intermedio', async () => {
    await seedRenta();
    const spy = jest
      .spyOn(
        entryHandler as unknown as { saveRefs: () => Promise<void> },
        'saveRefs',
      )
      .mockRejectedValueOnce(new Error('injected'));
    const e = sobre('registro/sobre-entry-cash-valid.json');
    await expect(push(e)).rejects.toThrow('injected');
    spy.mockRestore();
    expect(
      await db.manager.findOneBy(EventEntity, { eventId: e.event_id }),
    ).toBeNull();
    expect(await db.manager.count(FinancialEntryEntity)).toBe(0);
    expect((await push(e)).status).toBe('accepted');
    expect(await db.manager.count(FinancialEntryEntity)).toBe(1);
  });

  it('dependencia inexistente queda en incidencia sin crear proyecciones', async () => {
    const e = entry({
      eventId: randomUUID(),
      aggregateId: randomUUID(),
      categoryId: randomUUID(),
      categoryEventId: randomUUID(),
      categoryName: 'Renta',
      direction: 'out',
      nature: 'operating',
      amount: 50000,
      method: 'cash',
      occurredAtMs: 1789041600000,
      notes: 'Renta en efectivo',
    });
    const result = await push(e);
    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'La categoría del registro no está disponible en el servidor.',
    });
    expect(await db.manager.count(FinancialCategoryEntity)).toBe(0);
    expect(await db.manager.count(FinancialEntryEntity)).toBe(0);
    expect(
      (await db.manager.findOneByOrFail(EventEntity, { eventId: e.event_id }))
        .syncStatus,
    ).toBe(EventSyncStatus.CONFLICT);
  });

  it('categoría con evento de creación pendiente no habilita el registro', async () => {
    await db.manager.save(EventEntity, {
      eventId: RENTA_EVT,
      aggregateType: 'financial_category',
      aggregateId: RENTA_ID,
      eventType: 'categoria_financiera_creada',
      deviceId: FALLBACK_DEVICE,
      userId: FALLBACK_USER,
      localSequence: 1,
      baseVersion: 1,
      baseServerSequence: null,
      createdAtLocal: new Date(FALLBACK_CREATED_AT),
      payload: { name: 'Renta', direction: 'out', nature: 'operating' },
      syncStatus: EventSyncStatus.PENDING,
      rejectionReason: null,
    });
    await db.manager.insert(FinancialCategoryEntity, {
      id: RENTA_ID,
      name: 'Renta',
      direction: 'out',
      nature: 'operating',
      active: true,
      version: 1,
      createdEventId: RENTA_EVT,
      lastEventId: RENTA_EVT,
      lastServerSequence: '1',
    });
    const result = await push(sobre('registro/sobre-entry-cash-valid.json'));
    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'La categoría del registro no está disponible en el servidor.',
    });
    expect(
      (await push(sobre('registro/sobre-entry-cash-valid.json'))).status,
    ).toBe('duplicate');
  });

  it('categoría con created_event_id distinto al del payload no es oficial', async () => {
    await seedRenta();
    const e = sobre('registro/sobre-entry-cash-valid.json');
    e.payload.category_event_id = randomUUID();
    const result = await push(e);
    expect(result).toMatchObject({
      status: 'conflict',
      reason: 'La categoría del registro no está disponible en el servidor.',
    });
    expect(await db.manager.count(FinancialEntryEntity)).toBe(0);
  });

  it('snapshot de dirección o naturaleza distinto es conflicto de clasificación', async () => {
    await seedRenta();
    const byDirection = entry({
      eventId: randomUUID(),
      aggregateId: randomUUID(),
      categoryId: RENTA_ID,
      categoryEventId: RENTA_EVT,
      categoryName: 'Renta',
      direction: 'in',
      nature: 'operating',
      amount: 50000,
      method: 'cash',
      occurredAtMs: 1789041600000,
      notes: 'Renta en efectivo',
    });
    expect(await push(byDirection)).toMatchObject({
      status: 'conflict',
      reason:
        'La clasificación del registro no coincide con la categoría oficial.',
    });

    const byNature = entry({
      eventId: randomUUID(),
      aggregateId: randomUUID(),
      categoryId: RENTA_ID,
      categoryEventId: RENTA_EVT,
      categoryName: 'Renta',
      direction: 'out',
      nature: 'capital',
      amount: 50000,
      method: 'cash',
      occurredAtMs: 1789041600000,
      notes: 'Renta en efectivo',
    });
    expect(await push(byNature)).toMatchObject({
      status: 'conflict',
      reason:
        'La clasificación del registro no coincide con la categoría oficial.',
    });
    expect(await db.manager.count(FinancialEntryEntity)).toBe(0);
  });

  it('pull expone solo eventos synced (no conflictos ni rechazados)', async () => {
    await seedRenta();
    expect(
      (await push(sobre('registro/sobre-entry-cash-valid.json'))).status,
    ).toBe('accepted');
    const colliding = readFinancialFixture(
      'conflictos/colision-registro-mismo-aggregate-id.json',
    ) as unknown as { evento_colision: PushEventDto };
    expect((await push(colliding.evento_colision)).status).toBe('conflict');
    const invalid = {
      ...sobre('registro/sobre-base-version-invalid.json'),
      event_id: randomUUID(),
    };
    expect((await push(invalid)).status).toBe('rejected');

    const pulled = await service.pullEvents({ since: 0 });
    const ids = pulled.events.map((e) => e.event_id);
    expect(ids).toContain(RENTA_EVT);
    expect(ids).toContain(CASH_EVT);
    expect(ids).not.toContain(colliding.evento_colision.event_id);
    expect(ids).not.toContain(invalid.event_id);
  });

  it('preflight devuelve eventos que impactan la categoría por refs', async () => {
    await seedRenta();
    expect(
      (await push(sobre('registro/sobre-entry-cash-valid.json'))).status,
    ).toBe('accepted');
    const result = await service.preflightEvents({
      device_id: 'dispositivo-2',
      last_full_pull_server_sequence: 0,
      pending_refs: [
        {
          event_id: randomUUID(),
          event_type: 'movimiento_financiero_registrado',
          aggregate_type: 'financial_entry',
          aggregate_id: randomUUID(),
          refs: [
            {
              type: 'financial_category',
              id: RENTA_ID,
              relationship: 'uses',
            },
          ],
        },
      ],
    });
    expect(result.events.map((e) => e.event_id)).toEqual(
      expect.arrayContaining([RENTA_EVT, CASH_EVT]),
    );
  });

  it('reporte financiero respeta [from, to) y suma totales por dirección y método', async () => {
    await seedDataset();
    const reports = new FinancialReportService(db);

    const sept = await reports.report(FROM_SEP, TO_OCT);
    expect(sept).toMatchObject({
      income_minor: '200000',
      expense_minor: '200000',
      cash_minor: '250000',
      transfer_minor: '150000',
      net_minor: '0',
    });
    expect(sept.movements.map((m) => m.id)).toEqual([
      TRANSFER_ID,
      INCOME_ID,
      CASH_ID,
    ]);
    expect(sept.movements.find((m) => m.id === TRANSFER_ID)).toMatchObject({
      category_id: RENTA_ID,
      category_name_snapshot: 'Renta',
      method: 'transfer',
      occurred_at_ms: 1789929000000,
      notes: 'Renta de septiembre',
      reference: 'SPEI-2026-09-20',
    });

    const exactTo = await reports.report(TO_OCT, TO_OCT + 1000);
    expect(exactTo.movements).toHaveLength(1);
    expect(exactTo.expense_minor).toBe('12345');

    const beforeFrom = await reports.report(FROM_SEP - 1000, FROM_SEP);
    expect(beforeFrom.movements).toHaveLength(1);
    expect(beforeFrom.expense_minor).toBe('67890');

    expect(
      (await reports.report(FROM_SEP, FROM_SEP + 1)).movements,
    ).toHaveLength(0);

    const cash = await reports.report(FROM_SEP, TO_OCT, { method: 'cash' });
    expect(cash).toMatchObject({ cash_minor: '250000', transfer_minor: '0' });
    expect(cash.movements).toHaveLength(2);
    expect(cash.movements.every((m) => m.method === 'cash')).toBe(true);

    const out = await reports.report(FROM_SEP, TO_OCT, { direction: 'out' });
    expect(out).toMatchObject({
      expense_minor: '200000',
      income_minor: '0',
    });
    expect(out.movements).toHaveLength(2);

    const renta = await reports.report(FROM_SEP, TO_OCT, {
      categoryId: RENTA_ID,
    });
    expect(renta).toMatchObject({
      expense_minor: '200000',
      transfer_minor: '150000',
    });
    expect(renta.movements).toHaveLength(2);

    await expect(reports.report(TO_OCT, FROM_SEP)).rejects.toThrow(
      'Período inválido',
    );
    await expect(
      reports.report(FROM_SEP, TO_OCT, { method: 'card' }),
    ).rejects.toThrow('method debe ser cash o transfer.');
    await expect(
      reports.report(FROM_SEP, TO_OCT, { direction: 'sideways' }),
    ).rejects.toThrow('direction debe ser in u out.');
    await expect(
      reports.report(FROM_SEP, TO_OCT, { categoryId: 'no-es-uuid' }),
    ).rejects.toThrow('category_id debe ser un UUID v4.');
  });
});
