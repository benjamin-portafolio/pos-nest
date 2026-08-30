import { DataSource } from 'typeorm';
import { UpdateInventoryMovementFlow1788177600000 } from './1788177600000-UpdateInventoryMovementFlow';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

runPostgresIntegration(
  'UpdateInventoryMovementFlow con PostgreSQL real',
  () => {
    jest.setTimeout(30_000);

    const schema = `inventory_flow_migration_it_${process.pid}_${Date.now()}`;
    let administration: DataSource;
    let database: DataSource;

    beforeAll(async () => {
      const connection = postgresConnectionOptions();
      administration = new DataSource(connection);
      await administration.initialize();
      await administration.query(`CREATE SCHEMA "${schema}"`);
      database = new DataSource({ ...connection, schema });
      await database.initialize();
      await database.query(`
      CREATE TABLE "${schema}"."inventory_balances" (
        "inventory_item_id" uuid PRIMARY KEY,
        "quantity_on_hand_atomic" bigint NOT NULL,
        "quantity_available_atomic" bigint NOT NULL,
        "last_event_id" uuid NOT NULL,
        "last_server_sequence" bigint
      )
    `);
      await database.query(`
      CREATE TABLE "${schema}"."inventory_movements" (
        "movement_id" uuid PRIMARY KEY,
        "inventory_item_id" uuid NOT NULL,
        "sale_item_id" uuid,
        "event_id" uuid NOT NULL,
        "reversal_of_movement_id" uuid,
        "movement_type" varchar(40) NOT NULL,
        "quantity_delta_atomic" bigint NOT NULL,
        "total_cost_minor" bigint,
        "reason" varchar(500) NOT NULL,
        "created_at_local" timestamptz(3) NOT NULL,
        "server_sequence" bigint,
        CONSTRAINT "ck_inventory_movements_non_zero"
          CHECK ("quantity_delta_atomic" <> 0),
        CONSTRAINT "fk_inventory_movements_reversal"
          FOREIGN KEY ("reversal_of_movement_id")
          REFERENCES "${schema}"."inventory_movements"("movement_id")
          ON DELETE RESTRICT
      )
    `);
      await database.query(`
      INSERT INTO "${schema}"."inventory_balances" VALUES (
        '20000000-0000-4000-8000-000000000001', 5, 5,
        '40000000-0000-4000-8000-000000000001', 1
      )
    `);
      await database.query(`
      INSERT INTO "${schema}"."inventory_movements" (
        "movement_id", "inventory_item_id", "event_id", "movement_type",
        "quantity_delta_atomic", "reason", "created_at_local"
      ) VALUES (
        '30000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001',
        'manual_adjustment', 5, 'Conteo histórico', now()
      )
    `);
    });

    afterAll(async () => {
      if (database?.isInitialized) await database.destroy();
      if (administration?.isInitialized) {
        await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
        await administration.destroy();
      }
    });

    it('migra reason nullable, agrega versión y aplica checks condicionales', async () => {
      const migration = new UpdateInventoryMovementFlow1788177600000();
      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}"`);
        await migration.up(runner);
      } finally {
        await runner.release();
      }

      await expect(
        database.query(`
        INSERT INTO "${schema}"."inventory_movements" (
          "movement_id", "inventory_item_id", "event_id", "movement_type",
          "quantity_delta_atomic", "reason", "created_at_local"
        ) VALUES (
          '30000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000002',
          'stock_receipt', 3, NULL, now()
        )
      `),
      ).resolves.toBeDefined();
      await expect(
        database.query(`
        INSERT INTO "${schema}"."inventory_movements" (
          "movement_id", "inventory_item_id", "event_id", "movement_type",
          "quantity_delta_atomic", "reason", "created_at_local"
        ) VALUES (
          '30000000-0000-4000-8000-000000000003',
          '20000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000003',
          'manual_adjustment', -1, NULL, now()
        )
      `),
      ).rejects.toThrow();
      await expect(
        database.query(`
        INSERT INTO "${schema}"."inventory_movements" (
          "movement_id", "inventory_item_id", "event_id", "movement_type",
          "quantity_delta_atomic", "reason", "created_at_local"
        ) VALUES (
          '30000000-0000-4000-8000-000000000004',
          '20000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000004',
          'stock_receipt', -1, NULL, now()
        )
      `),
      ).rejects.toThrow();
      await expect(
        database.query(`
        INSERT INTO "${schema}"."inventory_movements" (
          "movement_id", "inventory_item_id", "event_id", "movement_type",
          "quantity_delta_atomic", "reason", "created_at_local"
        ) VALUES (
          '30000000-0000-4000-8000-000000000005',
          '20000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000005',
          'stock_receipt', 1, ' Compra ', now()
        )
      `),
      ).rejects.toThrow();

      const columns = await database.query<
        Array<{ column_name: string; is_nullable: string }>
      >(
        `
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name IN ('inventory_balances', 'inventory_movements')
      `,
        [schema],
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ column_name: 'version' }),
          expect.objectContaining({
            column_name: 'reason',
            is_nullable: 'YES',
          }),
          expect.objectContaining({ column_name: 'total_cost_minor' }),
          expect.objectContaining({ column_name: 'reversal_of_movement_id' }),
        ]),
      );

      await database.query(`
      DELETE FROM "${schema}"."inventory_movements" WHERE "reason" IS NULL
    `);
      const downRunner = database.createQueryRunner();
      await downRunner.connect();
      try {
        await downRunner.query(`SET search_path TO "${schema}"`);
        await migration.down(downRunner);
      } finally {
        await downRunner.release();
      }
      const reason = await database.query<Array<{ is_nullable: string }>>(
        `
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = 'inventory_movements'
          AND column_name = 'reason'
      `,
        [schema],
      );
      expect(reason[0]?.is_nullable).toBe('NO');
    });
  },
);

function postgresConnectionOptions() {
  const required = [
    'DATABASE_HOST',
    'DATABASE_PORT',
    'DATABASE_USER',
    'DATABASE_PASSWORD',
    'DATABASE_NAME',
  ] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Falta ${key} para la integración.`);
  }
  return {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  };
}
