import { DataSource } from 'typeorm';
import { ReconstructLegacyVariantInventoryMemory1790860800000 } from './1790860800000-ReconstructLegacyVariantInventoryMemory';

const runPostgresIntegration =
  process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip;

/**
 * Identidades estables del escenario; las primeras coinciden con
 * `Fixtures/index.md`. Las `d2…` solo nombran variantes que ningún fixture
 * describe y existen para aislar cada regla de la reconstrucción.
 */
const PRODUCTO_MOLIDO = 'a1000000-0000-4000-8000-000000000001';
const PRODUCTO_AJENO = 'd1000000-0000-4000-8000-000000000002';
const VARIANTE_250G = 'a2000000-0000-4000-8000-000000000001';
const VARIANTE_RECETA = 'a2000000-0000-4000-8000-000000000002';
const VARIANTE_SIN_EVIDENCIA = 'a2000000-0000-4000-8000-000000000005';
const VARIANTE_RECURSO_INEXISTENTE = 'd2000000-0000-4000-8000-000000000001';
const VARIANTE_DE_OTRO_PRODUCTO = 'd2000000-0000-4000-8000-000000000002';
const VARIANTE_MALFORMADA = 'd2000000-0000-4000-8000-000000000003';
const VARIANTE_NO_SINCRONIZADA = 'd2000000-0000-4000-8000-000000000004';
const VARIANTE_DESACTIVADA = 'd2000000-0000-4000-8000-000000000005';
const VARIANTE_CON_MEMORIA = 'd2000000-0000-4000-8000-000000000006';
const VARIANTE_ANTES_DESPUES = 'd2000000-0000-4000-8000-000000000007';

const RECURSO_MOLIDO = 'a3000000-0000-4000-8000-000000000001';
const RECURSO_LEGADO = 'a3000000-0000-4000-8000-000000000003';
const RECURSO_AUSENTE = 'd3000000-0000-4000-8000-000000000001';

const EV_PRODUCTO_CREADO = 'b3000000-0000-4000-8000-000000000001';
const EV_PRODUCTO_RENOMBRE = 'b3000000-0000-4000-8000-000000000002';
const EV_PRODUCTO_DESVINCULA = 'b3000000-0000-4000-8000-000000000003';
const EV_PRODUCTO_DESACTIVA = 'b3000000-0000-4000-8000-000000000004';
const EV_PRODUCTO_TRASLADO = 'b3000000-0000-4000-8000-000000000005';
const EV_PRODUCTO_AJENO = 'b3000000-0000-4000-8000-000000000006';
const EV_PRODUCTO_ANTES_DESPUES = 'b3000000-0000-4000-8000-000000000007';
const EV_PRODUCTO_RECHAZADO = 'b3000000-0000-4000-8000-000000000008';

/**
 * Reconstrucción legada de `variant_inventory_memory` con PostgreSQL real
 * (contrato rev. 1 §8.2 y §8.3).
 *
 * El esquema es mínimo y escrito a mano: la migración solo lee `events`,
 * `product_variants` e `inventory_items`, y escribe `variant_inventory_memory`.
 * Cada caso aísla una regla — precedencia, filtro de sincronía, evidencia
 * ilegible, no sobrescritura — porque el riesgo real de una reconstrucción por
 * inferencia es inventar memoria, no omitirla.
 */
runPostgresIntegration(
  'ReconstructLegacyVariantInventoryMemory con PostgreSQL real',
  () => {
    jest.setTimeout(30_000);

    const schema = `legacy_memory_it_${process.pid}_${Date.now()}`;
    let administration: DataSource;
    let database: DataSource;
    // La migración informa por consola los casos que no pudo resolver. Se
    // captura en todo el archivo para que la salida del test sea legible y el
    // informe quede disponible como evidencia.
    let informes: string[] = [];
    let consola: jest.SpyInstance;

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

      // Estado previo: la fase 1 ya creó `origin_variant_id` y sembró los
      // vínculos directos vigentes. Solo faltan `products` y `inventory_items`.
      await database.query(`
        CREATE TABLE "${schema}".products (
          product_id uuid PRIMARY KEY
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".inventory_items (
          inventory_item_id uuid PRIMARY KEY,
          origin_variant_id uuid,
          active boolean NOT NULL DEFAULT true
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".product_variants (
          variant_id uuid PRIMARY KEY,
          product_id uuid NOT NULL
            REFERENCES products (product_id) ON DELETE CASCADE,
          inventory_item_id uuid
            REFERENCES inventory_items (inventory_item_id) ON DELETE RESTRICT,
          active boolean NOT NULL DEFAULT true
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".events (
          event_id uuid PRIMARY KEY,
          aggregate_type varchar(80) NOT NULL,
          aggregate_id uuid NOT NULL,
          event_type varchar(120) NOT NULL,
          server_sequence bigint NOT NULL,
          payload jsonb NOT NULL,
          sync_status varchar(20) NOT NULL
        )
      `);
      await database.query(`
        CREATE TABLE "${schema}".variant_inventory_memory (
          variant_id uuid PRIMARY KEY
            REFERENCES product_variants (variant_id) ON DELETE CASCADE,
          inventory_item_id uuid NOT NULL
            REFERENCES inventory_items (inventory_item_id) ON DELETE CASCADE,
          source_event_id uuid NOT NULL,
          source_server_sequence bigint
        )
      `);
      await database.query(
        `CREATE INDEX ix_variant_inventory_memory_item
           ON "${schema}".variant_inventory_memory (inventory_item_id)`,
      );
    });

    afterAll(async () => {
      if (database?.isInitialized) await database.destroy();
      if (administration?.isInitialized) {
        await administration.query(`DROP SCHEMA "${schema}" CASCADE`);
        await administration.destroy();
      }
    });

    beforeEach(async () => {
      informes = [];
      consola = jest
        .spyOn(console, 'log')
        .mockImplementation((mensaje: unknown) => {
          informes.push(String(mensaje));
        });
      await database.query(`
        TRUNCATE TABLE
          "${schema}"."variant_inventory_memory",
          "${schema}"."product_variants",
          "${schema}"."products",
          "${schema}"."inventory_items",
          "${schema}"."events"
        RESTART IDENTITY CASCADE
      `);
      await seedPreviousState();
    });

    afterEach(() => {
      consola.mockRestore();
    });

    it('reconstruye solo las memorias demostrables, con la evidencia más reciente', async () => {
      await runUp();

      expect(await memorias()).toEqual([
        {
          variant_id: VARIANTE_250G,
          inventory_item_id: RECURSO_MOLIDO,
          // La desvinculación (seq. 47) es el evento más reciente que declara
          // el vínculo, y lo declara en su `before`.
          source_event_id: EV_PRODUCTO_DESVINCULA,
          source_server_sequence: '47',
        },
        {
          variant_id: VARIANTE_DESACTIVADA,
          inventory_item_id: RECURSO_MOLIDO,
          // La variante quedó inactiva y su evento `delete_product` (seq. 55) no
          // cuenta como evidencia: la última que declara el vínculo es la
          // desvinculación.
          source_event_id: EV_PRODUCTO_DESVINCULA,
          source_server_sequence: '47',
        },
        {
          variant_id: VARIANTE_CON_MEMORIA,
          inventory_item_id: RECURSO_MOLIDO,
          source_event_id: EV_PRODUCTO_CREADO,
          source_server_sequence: '41',
        },
        {
          variant_id: VARIANTE_ANTES_DESPUES,
          inventory_item_id: RECURSO_LEGADO,
          // Mismo evento, misma secuencia: dentro del evento gana `after`,
          // porque es el estado resultante.
          source_event_id: EV_PRODUCTO_ANTES_DESPUES,
          source_server_sequence: '60',
        },
      ]);
    });

    it('deja sin memoria las variantes sin evidencia demostrable', async () => {
      await runUp();

      // Receta, sin eventos que la mencionen, recurso inexistente, variante de
      // otro producto, identificador malformado y evento no sincronizado.
      expect(
        await database.query<Array<{ variant_id: string }>>(
          `SELECT variant_id
           FROM product_variants
           WHERE variant_id IN (
             '${VARIANTE_RECETA}',
             '${VARIANTE_SIN_EVIDENCIA}',
             '${VARIANTE_RECURSO_INEXISTENTE}',
             '${VARIANTE_DE_OTRO_PRODUCTO}',
             '${VARIANTE_MALFORMADA}',
             '${VARIANTE_NO_SINCRONIZADA}'
           )
           AND variant_id IN (SELECT variant_id FROM variant_inventory_memory)`,
        ),
      ).toEqual([]);
      // Y reconstruye exactamente cuatro filas.
      expect(await countMemorias()).toBe('4');
    });

    it('no sobrescribe la memoria que ya existe', async () => {
      await runUp();

      // `producto_actualizado` (seq. 50) movió la variante a otro recurso, pero
      // la fila previa no se toca: la fase 1 y los handlers escriben ahí.
      expect(
        await database.query<Array<Record<string, string>>>(
          `SELECT inventory_item_id, source_event_id, source_server_sequence
           FROM variant_inventory_memory
           WHERE variant_id = '${VARIANTE_CON_MEMORIA}'`,
        ),
      ).toEqual([
        {
          inventory_item_id: RECURSO_MOLIDO,
          source_event_id: EV_PRODUCTO_CREADO,
          source_server_sequence: '41',
        },
      ]);
    });

    it('no inventa la procedencia de los recursos legados', async () => {
      await runUp();

      expect(
        await database.query<Array<{ origin_variant_id: string | null }>>(
          `SELECT origin_variant_id FROM inventory_items
           ORDER BY inventory_item_id`,
        ),
      ).toEqual([{ origin_variant_id: null }, { origin_variant_id: null }]);
    });

    it('no modifica los eventos históricos', async () => {
      const antes = await database.query<Array<Record<string, unknown>>>(
        `SELECT event_id, payload, sync_status, server_sequence
         FROM events ORDER BY server_sequence`,
      );

      await runUp();

      expect(
        await database.query<Array<Record<string, unknown>>>(
          `SELECT event_id, payload, sync_status, server_sequence
           FROM events ORDER BY server_sequence`,
        ),
      ).toEqual(antes);
    });

    it('informa los casos no resueltos en vez de inventar memoria', async () => {
      await runUp();

      expect(consola).toHaveBeenCalledTimes(1);
      expect(JSON.parse(informes[0]!)).toMatchObject({
        filas_de_memoria: 4,
        variantes_sin_memoria: 6,
        // Evidencia declarada pero no comprobable: recurso ausente y evidencia
        // apuntando a otro producto.
        variantes_con_evidencia_incompleta: 2,
        variantes_sin_evidencia_demostrable: 4,
      });
      // Los casos sin memoria se nombran uno por uno.
      expect(
        JSON.parse(informes[0]!).ejemplos_de_variantes_sin_memoria,
      ).toHaveLength(6);
    });

    it('es idempotente: un segundo up no agrega ni cambia filas', async () => {
      await runUp();
      const primera = await memorias();

      await runUp();

      expect(await memorias()).toEqual(primera);
      expect(await countMemorias()).toBe('4');
    });

    it('down conserva las filas: la proyección no se puede perder', async () => {
      await runUp();
      const antes = await memorias();

      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}"`);
        await new ReconstructLegacyVariantInventoryMemory1790860800000().down(
          runner,
        );
      } finally {
        await runner.release();
      }

      expect(await memorias()).toEqual(antes);
    });

    /** Configuración directa de una variante, en la forma del payload. */
    function estadoCon(
      variantes: Array<{ variant_id: string; inventory_item_id?: string }>,
    ) {
      return {
        product: { name: 'Café molido', category_id: null },
        variants: variantes.map((variante, indice) => ({
          ...variante,
          name: `Variante ${indice}`,
          sale_price_minor: 4500,
          sort_order: indice,
        })),
        dependencies: [],
      };
    }

    async function insertEvent(
      eventId: string,
      eventType: string,
      serverSequence: number,
      payload: unknown,
      options: {
        aggregateId?: string;
        syncStatus?: string;
      } = {},
    ): Promise<void> {
      await database.query(
        `INSERT INTO "${schema}".events (
           event_id, aggregate_type, aggregate_id, event_type,
           server_sequence, payload, sync_status
         ) VALUES ($1, 'product', $2, $3, $4, $5::jsonb, $6)`,
        [
          eventId,
          options.aggregateId ?? PRODUCTO_MOLIDO,
          eventType,
          serverSequence,
          JSON.stringify(payload),
          options.syncStatus ?? 'synced',
        ],
      );
    }

    async function seedPreviousState(): Promise<void> {
      await database.query(
        `INSERT INTO "${schema}".inventory_items (
           inventory_item_id, origin_variant_id, active
         ) VALUES
           ('${RECURSO_MOLIDO}', NULL, true),
           ('${RECURSO_LEGADO}', NULL, true)`,
      );
      await database.query(
        `INSERT INTO "${schema}".products (product_id) VALUES
           ('${PRODUCTO_MOLIDO}'),
           ('${PRODUCTO_AJENO}')`,
      );
      await database.query(`
        INSERT INTO "${schema}".product_variants (
          variant_id, product_id, inventory_item_id, active
        ) VALUES
          -- Desvinculada antes de existir la tabla de memoria: caso principal.
          ('${VARIANTE_250G}', '${PRODUCTO_MOLIDO}', NULL, true),
          -- Nunca tuvo vínculo directo: solo receta.
          ('${VARIANTE_RECETA}', '${PRODUCTO_MOLIDO}', NULL, true),
          -- Ningún evento de producto la menciona.
          ('${VARIANTE_SIN_EVIDENCIA}', '${PRODUCTO_MOLIDO}', NULL, true),
          -- Su evidencia apunta a un recurso que no existe.
          ('${VARIANTE_RECURSO_INEXISTENTE}', '${PRODUCTO_MOLIDO}', NULL, true),
          -- Su evidencia pertenece a otro producto.
          ('${VARIANTE_DE_OTRO_PRODUCTO}', '${PRODUCTO_MOLIDO}', NULL, true),
          -- Su evidencia trae un identificador malformado.
          ('${VARIANTE_MALFORMADA}', '${PRODUCTO_MOLIDO}', NULL, true),
          -- Solo un evento rechazado declara su vínculo.
          ('${VARIANTE_NO_SINCRONIZADA}', '${PRODUCTO_MOLIDO}', NULL, true),
          -- El producto se desactivó con el vínculo aún declarado.
          ('${VARIANTE_DESACTIVADA}', '${PRODUCTO_MOLIDO}', NULL, false),
          -- Ya tiene memoria: no se debe sobrescribir.
          ('${VARIANTE_CON_MEMORIA}', '${PRODUCTO_MOLIDO}', NULL, true),
          ('${VARIANTE_ANTES_DESPUES}', '${PRODUCTO_MOLIDO}', NULL, true)
      `);
      await database.query(`
        INSERT INTO "${schema}".variant_inventory_memory (
          variant_id, inventory_item_id, source_event_id, source_server_sequence
        ) VALUES (
          '${VARIANTE_CON_MEMORIA}', '${RECURSO_MOLIDO}',
          '${EV_PRODUCTO_CREADO}', 41
        )
      `);

      const creado = estadoCon([
        { variant_id: VARIANTE_250G, inventory_item_id: RECURSO_MOLIDO },
        { variant_id: VARIANTE_RECETA },
        { variant_id: VARIANTE_SIN_EVIDENCIA },
        {
          variant_id: VARIANTE_RECURSO_INEXISTENTE,
          inventory_item_id: RECURSO_AUSENTE,
        },
        {
          variant_id: VARIANTE_MALFORMADA,
          inventory_item_id: 'no-es-un-uuid',
        },
        { variant_id: VARIANTE_DESACTIVADA, inventory_item_id: RECURSO_MOLIDO },
        {
          variant_id: VARIANTE_CON_MEMORIA,
          inventory_item_id: RECURSO_MOLIDO,
        },
        {
          variant_id: VARIANTE_ANTES_DESPUES,
          inventory_item_id: RECURSO_MOLIDO,
        },
      ]);
      await insertEvent(EV_PRODUCTO_CREADO, 'producto_creado', 41, creado);

      await insertEvent(EV_PRODUCTO_RENOMBRE, 'producto_actualizado', 45, {
        base_event_id: EV_PRODUCTO_CREADO,
        before: creado,
        after: creado,
      });
      await insertEvent(EV_PRODUCTO_DESVINCULA, 'producto_actualizado', 47, {
        base_event_id: EV_PRODUCTO_CREADO,
        before: creado,
        after: estadoCon([
          { variant_id: VARIANTE_250G },
          { variant_id: VARIANTE_RECETA },
          { variant_id: VARIANTE_SIN_EVIDENCIA },
          {
            variant_id: VARIANTE_RECURSO_INEXISTENTE,
            inventory_item_id: RECURSO_AUSENTE,
          },
          {
            variant_id: VARIANTE_MALFORMADA,
            inventory_item_id: 'no-es-un-uuid',
          },
          {
            variant_id: VARIANTE_DESACTIVADA,
            inventory_item_id: RECURSO_MOLIDO,
          },
          {
            variant_id: VARIANTE_CON_MEMORIA,
            inventory_item_id: RECURSO_MOLIDO,
          },
          {
            variant_id: VARIANTE_ANTES_DESPUES,
            inventory_item_id: RECURSO_MOLIDO,
          },
        ]),
      });
      // Desactiva el producto declarando además un recurso distinto: si este
      // evento contara como evidencia, la memoria de la variante inactiva
      // apuntaría al recurso equivocado.
      await insertEvent(EV_PRODUCTO_DESACTIVA, 'producto_actualizado', 55, {
        base_event_id: EV_PRODUCTO_DESVINCULA,
        delete_product: true,
        before: estadoCon([
          {
            variant_id: VARIANTE_DESACTIVADA,
            inventory_item_id: RECURSO_MOLIDO,
          },
        ]),
        after: null,
      });
      // Traslada una sola variante a otro recurso. Su `before` y su `after`
      // declaran únicamente esa variante: un `before` completo volvería a
      // acreditar los vínculos de todas las demás y los mezclaría.
      await insertEvent(EV_PRODUCTO_TRASLADO, 'producto_actualizado', 50, {
        base_event_id: EV_PRODUCTO_CREADO,
        before: estadoCon([
          {
            variant_id: VARIANTE_CON_MEMORIA,
            inventory_item_id: RECURSO_MOLIDO,
          },
        ]),
        after: estadoCon([
          {
            variant_id: VARIANTE_CON_MEMORIA,
            inventory_item_id: RECURSO_LEGADO,
          },
        ]),
      });
      // Un solo evento con las dos caras: dentro de él gana `after`.
      await insertEvent(EV_PRODUCTO_ANTES_DESPUES, 'producto_actualizado', 60, {
        base_event_id: EV_PRODUCTO_CREADO,
        before: estadoCon([
          {
            variant_id: VARIANTE_ANTES_DESPUES,
            inventory_item_id: RECURSO_MOLIDO,
          },
        ]),
        after: estadoCon([
          {
            variant_id: VARIANTE_ANTES_DESPUES,
            inventory_item_id: RECURSO_LEGADO,
          },
        ]),
      });
      // Evidencia de una variante que pertenece a otro producto.
      await insertEvent(
        EV_PRODUCTO_AJENO,
        'producto_creado',
        44,
        estadoCon([
          {
            variant_id: VARIANTE_DE_OTRO_PRODUCTO,
            inventory_item_id: RECURSO_MOLIDO,
          },
        ]),
        { aggregateId: PRODUCTO_AJENO },
      );
      // Único evento que declara el vínculo de la variante no sincronizada.
      await insertEvent(
        EV_PRODUCTO_RECHAZADO,
        'producto_actualizado',
        51,
        {
          base_event_id: EV_PRODUCTO_CREADO,
          before: estadoCon([
            {
              variant_id: VARIANTE_NO_SINCRONIZADA,
              inventory_item_id: RECURSO_MOLIDO,
            },
          ]),
          after: estadoCon([
            {
              variant_id: VARIANTE_NO_SINCRONIZADA,
              inventory_item_id: RECURSO_MOLIDO,
            },
          ]),
        },
        { syncStatus: 'rejected' },
      );
    }

    async function runUp(): Promise<void> {
      const runner = database.createQueryRunner();
      await runner.connect();
      try {
        await runner.query(`SET search_path TO "${schema}"`);
        const migration =
          new ReconstructLegacyVariantInventoryMemory1790860800000();
        await migration.up(runner);
      } finally {
        await runner.release();
      }
    }

    async function memorias(): Promise<Array<Record<string, string>>> {
      return database.query(`
        SELECT variant_id, inventory_item_id, source_event_id,
               source_server_sequence
        FROM variant_inventory_memory
        ORDER BY variant_id
      `);
    }

    async function countMemorias(): Promise<string> {
      const filas = await database.query<Array<{ count: string }>>(
        `SELECT count(*) FROM variant_inventory_memory`,
      );
      return filas[0]!.count;
    }
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
