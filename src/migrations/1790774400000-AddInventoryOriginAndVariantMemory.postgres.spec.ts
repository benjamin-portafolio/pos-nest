import { DataSource } from 'typeorm';
import { AddInventoryOriginAndVariantMemory1790774400000 } from './1790774400000-AddInventoryOriginAndVariantMemory';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

/** Identidades estables de los escenarios; coinciden con `Fixtures/index.md`. */
const PRODUCTO_MOLIDO = 'a1000000-0000-4000-8000-000000000001';
const VARIANTE_250G = 'a2000000-0000-4000-8000-000000000001';
const VARIANTE_RECETA = 'a2000000-0000-4000-8000-000000000002';
const VARIANTE_INACTIVA = 'a2000000-0000-4000-8000-000000000004';
const VARIANTE_SIN_EVIDENCIA = 'a2000000-0000-4000-8000-000000000005';
const RECURSO_AUTOGENERADO = 'a3000000-0000-4000-8000-000000000001';
const RECURSO_RECETA = 'a4000000-0000-4000-8000-000000000001';
const UNIDAD_GRAMO = 'a5000000-0000-4000-8000-000000000002';

const EV_ALTA_AUTOGENERADO = 'b1000000-0000-4000-8000-000000000001';
const EV_ALTA_RECETA = 'b1000000-0000-4000-8000-000000000004';
const EV_CATEGORIA = 'c1000000-0000-4000-8000-000000000001';
const EV_PRODUCTO_CREADO = 'b3000000-0000-4000-8000-000000000001';
const EV_PRODUCTO_RENOMBRE = 'b3000000-0000-4000-8000-000000000002';
const EV_PRODUCTO_DESVINCULA = 'b3000000-0000-4000-8000-000000000003';

runPostgresIntegration(
  'AddInventoryOriginAndVariantMemory con PostgreSQL real',
  () => {
    jest.setTimeout(30_000);

    const schema = `variant_memory_it_${process.pid}_${Date.now()}`;
    let administration: DataSource;
    let database: DataSource;

    beforeAll(async () => {
      const connection = postgresConnectionOptions();
      administration = new DataSource(connection);
      await administration.initialize();
      await administration.query(`CREATE SCHEMA "${schema}"`);
      // `search_path` a nivel de conexión: las consultas sin calificar (seed,
      // aserciones y migración) deben operar solo sobre el esquema aislado.
      // TypeORM solo aplica `schema` a las consultas que él genera; `query()`
      // usa el `search_path` de la sesión, que por defecto sería `public`.
      database = new DataSource({
        ...connection,
        schema,
        extra: { options: `-c search_path=${schema},public` },
      });
      await database.initialize();

      // Esquema previo a la migración, reducido a las columnas que la
      // siembra necesita leer. Ninguna fila se modifica después.
      await database.query(`
        CREATE TABLE "${schema}".units (
          unit_id uuid PRIMARY KEY
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".inventory_items (
          inventory_item_id uuid PRIMARY KEY,
          default_unit_id uuid NOT NULL REFERENCES units (unit_id),
          name varchar(160) NOT NULL,
          active boolean NOT NULL DEFAULT true,
          version integer NOT NULL DEFAULT 1,
          created_event_id uuid,
          last_event_id uuid,
          last_server_sequence bigint
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".products (
          product_id uuid PRIMARY KEY
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".product_variants (
          variant_id uuid PRIMARY KEY,
          product_id uuid NOT NULL REFERENCES products (product_id) ON DELETE CASCADE,
          name varchar(160),
          sale_price_minor bigint NOT NULL,
          sort_order integer NOT NULL,
          inventory_item_id uuid REFERENCES inventory_items (inventory_item_id) ON DELETE RESTRICT,
          active boolean NOT NULL DEFAULT true,
          version integer NOT NULL DEFAULT 1,
          created_event_id uuid,
          last_event_id uuid,
          last_server_sequence bigint
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".inventory_balances (
          inventory_item_id uuid PRIMARY KEY
            REFERENCES inventory_items (inventory_item_id) ON DELETE CASCADE,
          quantity_on_hand_atomic bigint NOT NULL,
          quantity_available_atomic bigint NOT NULL
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".inventory_movements (
          movement_id uuid PRIMARY KEY,
          inventory_item_id uuid NOT NULL
            REFERENCES inventory_items (inventory_item_id) ON DELETE RESTRICT,
          quantity_delta_atomic bigint NOT NULL
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".recipe_components (
          variant_id uuid NOT NULL REFERENCES product_variants (variant_id) ON DELETE CASCADE,
          inventory_item_id uuid NOT NULL
            REFERENCES inventory_items (inventory_item_id) ON DELETE RESTRICT,
          quantity_atomic bigint NOT NULL,
          PRIMARY KEY (variant_id, inventory_item_id)
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".events (
          event_id uuid PRIMARY KEY,
          aggregate_type varchar(80) NOT NULL,
          aggregate_id uuid NOT NULL,
          event_type varchar(120) NOT NULL,
          device_id varchar(120) NOT NULL,
          user_id varchar(120) NOT NULL,
          local_sequence integer,
          server_sequence bigint NOT NULL,
          created_at_local timestamptz NOT NULL,
          payload jsonb NOT NULL,
          sync_status varchar(20) NOT NULL
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

    async function seedPreviousState(): Promise<void> {
      await database.query(
        `INSERT INTO "${schema}".units (unit_id) VALUES ('${UNIDAD_GRAMO}')`,
      );
      await database.query(`
        INSERT INTO "${schema}".inventory_items (
          inventory_item_id, default_unit_id, name, active, version,
          created_event_id, last_event_id, last_server_sequence
        ) VALUES
          ('${RECURSO_AUTOGENERADO}', '${UNIDAD_GRAMO}', 'Café molido 250 g',
           true, 1, '${EV_ALTA_AUTOGENERADO}', '${EV_CATEGORIA}', 41),
          ('${RECURSO_RECETA}', '${UNIDAD_GRAMO}', 'Café en grano 1 kg',
           true, 1, '${EV_ALTA_RECETA}', '${EV_ALTA_RECETA}', 42)
      `);
      await database.query(
        `INSERT INTO "${schema}".products (product_id) VALUES ('${PRODUCTO_MOLIDO}')`,
      );
      await database.query(`
        INSERT INTO "${schema}".product_variants (
          variant_id, product_id, name, sale_price_minor, sort_order,
          inventory_item_id, active, version, created_event_id, last_event_id,
          last_server_sequence
        ) VALUES
          ('${VARIANTE_250G}', '${PRODUCTO_MOLIDO}', '250 g', 4500, 0,
           '${RECURSO_AUTOGENERADO}', true, 2, '${EV_PRODUCTO_CREADO}',
           '${EV_CATEGORIA}', 41),
          ('${VARIANTE_RECETA}', '${PRODUCTO_MOLIDO}', '1 kg', 15000, 1,
           NULL, true, 1, '${EV_PRODUCTO_CREADO}', '${EV_PRODUCTO_CREADO}', 41),
          ('${VARIANTE_INACTIVA}', '${PRODUCTO_MOLIDO}', '500 g', 9000, 2,
           '${RECURSO_RECETA}', false, 1, '${EV_PRODUCTO_CREADO}',
           '${EV_PRODUCTO_CREADO}', 41),
          ('${VARIANTE_SIN_EVIDENCIA}', '${PRODUCTO_MOLIDO}', '2 kg', 28000, 3,
           '${RECURSO_RECETA}', true, 1, NULL, NULL, NULL)
      `);
      await database.query(`
        INSERT INTO "${schema}".inventory_balances (
          inventory_item_id, quantity_on_hand_atomic, quantity_available_atomic
        ) VALUES ('${RECURSO_AUTOGENERADO}', 250, 250)
      `);
      await database.query(`
        INSERT INTO "${schema}".inventory_movements (
          movement_id, inventory_item_id, quantity_delta_atomic
        ) VALUES ('b2000000-0000-4000-8000-000000000001',
                  '${RECURSO_AUTOGENERADO}', 250)
      `);
      await database.query(`
        INSERT INTO "${schema}".recipe_components (
          variant_id, inventory_item_id, quantity_atomic
        ) VALUES ('${VARIANTE_RECETA}', '${RECURSO_RECETA}', 1000)
      `);

      const productoCreado = {
        product: { name: 'Café molido', category_id: null },
        variants: [
          {
            variant_id: VARIANTE_250G,
            name: '250 g',
            sale_price_minor: 4500,
            inventory_item_id: RECURSO_AUTOGENERADO,
            sort_order: 0,
          },
          {
            variant_id: VARIANTE_RECETA,
            name: '1 kg',
            sale_price_minor: 15000,
            inventory_configuration: {
              enabled: true,
              components: [
                { inventory_item_id: RECURSO_RECETA, quantity_atomic: 1000 },
              ],
            },
            sort_order: 1,
          },
          {
            variant_id: VARIANTE_INACTIVA,
            name: '500 g',
            sale_price_minor: 9000,
            inventory_item_id: RECURSO_RECETA,
            sort_order: 2,
          },
        ],
        dependencies: [],
      };

      await insertEvent(
        EV_PRODUCTO_CREADO,
        'producto_creado',
        41,
        productoCreado,
      );
      // Un evento de otra versión del mismo producto, con `last_event_id` de
      // Categorías: no acredita el vínculo directo.
      await insertEvent(
        EV_CATEGORIA,
        'categoria_actualizada',
        40,
        { changes: { name: { from: 'Bebidas', to: 'Cafés' } } },
        PRODUCTO_MOLIDO,
      );
      // Renombrar el producto declara el mismo vínculo en `after`: la
      // secuencia oficial más reciente gana.
      await insertEvent(EV_PRODUCTO_RENOMBRE, 'producto_actualizado', 45, {
        base_event_id: EV_PRODUCTO_CREADO,
        before: productoCreado,
        after: {
          ...productoCreado,
          product: { name: 'Café molido premium', category_id: null },
        },
      });
      // Desvincula la variante 250 g: evidencia de una memoria legada, fuera
      // del alcance de esta siembra.
      await insertEvent(EV_PRODUCTO_DESVINCULA, 'producto_actualizado', 47, {
        base_event_id: EV_PRODUCTO_CREADO,
        before: productoCreado,
        after: {
          ...productoCreado,
          variants: productoCreado.variants.map((variant) =>
            variant.variant_id === VARIANTE_250G
              ? {
                  ...variant,
                  inventory_item_id: undefined,
                }
              : variant,
          ),
        },
      });
    }

    async function insertEvent(
      eventId: string,
      eventType: string,
      serverSequence: number,
      payload: unknown,
      aggregateId = PRODUCTO_MOLIDO,
    ): Promise<void> {
      await database.query(
        `INSERT INTO "${schema}".events (
           event_id, aggregate_type, aggregate_id, event_type, device_id,
           user_id, local_sequence, server_sequence, created_at_local,
           payload, sync_status
         ) VALUES (
           $1, 'product', $2, $3, 'dispositivo-1', 'usuario-1', 1, $4,
           '2026-10-01T12:00:00.000Z', $5::jsonb, 'synced'
         )`,
        [
          eventId,
          aggregateId,
          eventType,
          serverSequence,
          JSON.stringify(payload),
        ],
      );
    }

    async function runUp(): Promise<void> {
      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}"`);
        const migration = new AddInventoryOriginAndVariantMemory1790774400000();
        await migration.up(runner);
        // La migración es idempotente.
        await migration.up(runner);
      } finally {
        await runner.release();
      }
    }

    it('preserva filas, movimientos, saldos, recetas y eventos', async () => {
      await seedPreviousState();
      await runUp();

      expect(
        await database.query<Array<{ name: string }>>(
          `SELECT name FROM inventory_items ORDER BY name`,
        ),
      ).toEqual([
        { name: 'Café en grano 1 kg' },
        { name: 'Café molido 250 g' },
      ]);
      expect(
        await database.query<Array<{ inventory_item_id: string }>>(
          `SELECT inventory_item_id FROM inventory_movements`,
        ),
      ).toEqual([{ inventory_item_id: RECURSO_AUTOGENERADO }]);
      expect(
        await database.query<Array<{ quantity_on_hand_atomic: string }>>(
          `SELECT quantity_on_hand_atomic FROM inventory_balances`,
        ),
      ).toEqual([{ quantity_on_hand_atomic: '250' }]);
      expect(
        await database.query<Array<{ variant_id: string }>>(
          `SELECT variant_id FROM recipe_components`,
        ),
      ).toEqual([{ variant_id: VARIANTE_RECETA }]);
      expect(
        await database.query<Array<{ count: string }>>(
          `SELECT count(*) FROM events`,
        ),
      ).toEqual([{ count: '4' }]);
    });

    it('deja el origen de los recursos legados en NULL sin inventarlo', async () => {
      expect(
        await database.query<Array<{ origin_variant_id: string | null }>>(
          `SELECT origin_variant_id FROM inventory_items ORDER BY name`,
        ),
      ).toEqual([{ origin_variant_id: null }, { origin_variant_id: null }]);
    });

    it('siembra memoria solo con evidencia de producto comprobable', async () => {
      expect(
        await database.query<Array<Record<string, string | null>>>(
          `SELECT variant_id, inventory_item_id, source_event_id,
                  source_server_sequence
           FROM variant_inventory_memory
           ORDER BY variant_id`,
        ),
      ).toEqual([
        {
          variant_id: VARIANTE_250G,
          inventory_item_id: RECURSO_AUTOGENERADO,
          // No se copia last_event_id (que apunta a Categorías): gana el
          // producto_actualizado más reciente que declaró el vínculo.
          source_event_id: EV_PRODUCTO_RENOMBRE,
          source_server_sequence: '45',
        },
        {
          variant_id: VARIANTE_INACTIVA,
          inventory_item_id: RECURSO_RECETA,
          // La desvinculación (seq. 47) es el evento más reciente y declara
          // este vínculo intacto en su `after`: acredita también la memoria de
          // la variante que el evento no tocó.
          source_event_id: EV_PRODUCTO_DESVINCULA,
          source_server_sequence: '47',
        },
      ]);
      // La variante sin evidencia no recibe fila: ausencia de memoria no es
      // prueba de ausencia de vínculo anterior, y la reconstrucción
      // demostrable de variantes desvinculadas es de la fase 2.
      expect(
        await database.query<Array<{ count: string }>>(
          `SELECT count(*) FROM variant_inventory_memory
           WHERE variant_id = '${VARIANTE_SIN_EVIDENCIA}'`,
        ),
      ).toEqual([{ count: '0' }]);
    });

    it('el índice de procedencia no es único y no invarian las cascadas', async () => {
      const indexes = await database.query<Array<{ indexname: string }>>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = '${schema}'
          AND tablename = 'inventory_items'
      `);
      expect(indexes.map((row) => row.indexname)).toContain(
        'ix_inventory_items_origin_variant',
      );
      const unique = await database.query<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = '${schema}' AND indexname = 'ix_inventory_items_origin_variant'`,
      );
      expect(unique[0].indexdef).not.toMatch(/CREATE UNIQUE INDEX/);

      // Dos recursos con el mismo origen son admisibles.
      await database.query(`
        INSERT INTO inventory_items (
          inventory_item_id, default_unit_id, name
        ) VALUES ('a3000000-0000-4000-8000-000000000009', '${UNIDAD_GRAMO}',
                  'Café molido 250 g (segunda terminal)')
      `);
      await database.query(`
        UPDATE inventory_items SET origin_variant_id = '${VARIANTE_250G}'
        WHERE inventory_item_id IN ('${RECURSO_AUTOGENERADO}',
                                    'a3000000-0000-4000-8000-000000000009')
      `);
      expect(
        await database.query<Array<{ count: string }>>(
          `SELECT count(*) FROM inventory_items
           WHERE origin_variant_id = '${VARIANTE_250G}'`,
        ),
      ).toEqual([{ count: '2' }]);

      // Borrar el recurso conserva el vínculo directo que lo protege
      // (`ON DELETE RESTRICT` se reporta como restrict_violation, 23001).
      await expect(
        database.query(
          `DELETE FROM inventory_items WHERE inventory_item_id = '${RECURSO_AUTOGENERADO}'`,
        ),
      ).rejects.toMatchObject({ code: '23001' });

      // El movimiento histórico también protege el recurso (RESTRICT): la memoria no
      // lo exime de un saldo real, pero tampoco lo reemplaza.
      await expect(
        database.query(
          `DELETE FROM inventory_items WHERE inventory_item_id = '${RECURSO_AUTOGENERADO}'`,
        ),
      ).rejects.toMatchObject({ code: '23001' });

      // Al soltar el vínculo directo y vaciar el historial, borrar el recurso
      // retira solo su memoria.
      await database.query(
        `UPDATE product_variants SET inventory_item_id = NULL
         WHERE variant_id = '${VARIANTE_250G}'`,
      );
      await database.query(
        `DELETE FROM inventory_movements
         WHERE inventory_item_id = '${RECURSO_AUTOGENERADO}'`,
      );
      await database.query(
        `DELETE FROM inventory_items WHERE inventory_item_id = '${RECURSO_AUTOGENERADO}'`,
      );
      expect(
        await database.query<Array<{ count: string }>>(
          `SELECT count(*) FROM variant_inventory_memory
           WHERE inventory_item_id = '${RECURSO_AUTOGENERADO}'`,
        ),
      ).toEqual([{ count: '0' }]);
      expect(
        await database.query<Array<{ variant_id: string }>>(
          `SELECT variant_id FROM product_variants WHERE variant_id = '${VARIANTE_250G}'`,
        ),
      ).toEqual([{ variant_id: VARIANTE_250G }]);
    });

    it('la cascada de variante retira su memoria y conserva el recurso', async () => {
      await database.query(
        `DELETE FROM product_variants WHERE variant_id = '${VARIANTE_INACTIVA}'`,
      );
      expect(
        await database.query<Array<{ count: string }>>(
          `SELECT count(*) FROM variant_inventory_memory
           WHERE variant_id = '${VARIANTE_INACTIVA}'`,
        ),
      ).toEqual([{ count: '0' }]);
      expect(
        await database.query<Array<{ count: string }>>(
          `SELECT count(*) FROM inventory_items
           WHERE inventory_item_id = '${RECURSO_RECETA}'`,
        ),
      ).toEqual([{ count: '1' }]);
    });

    it('down retira memoria, índice y columna, y no se ofrece como recuperación', async () => {
      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}"`);
        await new AddInventoryOriginAndVariantMemory1790774400000().down(
          runner,
        );
      } finally {
        await runner.release();
      }

      const columns = await database.query<Array<{ name: string }>>(`
        SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = '${schema}' AND table_name = 'inventory_items'
      `);
      expect(columns.map((column) => column.name)).not.toContain(
        'origin_variant_id',
      );
      const tables = await database.query<Array<{ table_name: string }>>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = '${schema}'
      `);
      expect(tables.map((table) => table.table_name)).not.toContain(
        'variant_inventory_memory',
      );
      // Los datos de negocio siguen intactos: 3 sembrados, menos el que borró la
      // prueba de cascadas, más el segundo recurso con el mismo origen.
      expect(
        await database.query<Array<{ count: string }>>(
          `SELECT count(*) FROM inventory_items`,
        ),
      ).toEqual([{ count: '2' }]);
      expect(
        await database.query<Array<{ count: string }>>(
          `SELECT count(*) FROM events`,
        ),
      ).toEqual([{ count: '4' }]);
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
