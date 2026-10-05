import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 2 del plan de seguimiento de existencias (contrato rev. 1 §8.2 y §8.3):
 * reconstrucción legada, explícita y conservadora de `variant_inventory_memory`
 * para variantes **ya desvinculadas**.
 *
 * Vía elegida: **migración de datos**, no comando de mantenimiento. Se ejecuta
 * con el mismo control manual que ya usa este proyecto para el resto de
 * migraciones, queda registrada y es reproducible porque su resultado depende
 * solo de `events`, `product_variants` e `inventory_items`. Un comando habría
 * introducido una segunda superficie de ejecución para la misma proyección.
 *
 * Reglas (conservadoras por diseño):
 *
 * 1. **Vínculos actuales primero.** No se toca ninguna fila que ya exista en
 *    `variant_inventory_memory`: la migración de la fase 1 ya sembró los
 *    vínculos directos vigentes con su evento acreditador. Aquí solo se rellenan
 *    huecos.
 * 2. **Cadena demostrable.** La evidencia debe ser una cadena de eventos de
 *    producto **aceptados** (`sync_status = 'synced'`,
 *    `aggregate_type = 'product'`) que declaren el vínculo directo de esa
 *    variante concreta: `producto_creado.variants`, `producto_actualizado.after`
 *    y `producto_actualizado.before`. Gana la de mayor `server_sequence`; dentro
 *    del mismo evento gana `after` sobre `before`, porque `after` es el estado
 *    resultante y `before` es el que la desvinculación dejó atrás.
 * 3. **El último vínculo de esa variante**, no el último recurso creado. Nunca
 *    se elige por nombre, por reloj ni por "el más reciente del catálogo".
 * 4. **No se marca procedencia.** No se escribe
 *    `inventory_items.origin_variant_id`: un recurso legado sigue con origen
 *    desconocido, y origen desconocido no autoriza ningún descarte.
 * 5. **No modifica eventos históricos.** Solo inserta filas de la proyección.
 * 6. **Ambigüedad e historia incompleta no se resuelven por inferencia.** Una
 *    variante cuya evidencia apunta a otro producto, a un recurso inexistente o
 *    con identificadores malformados se deja **sin memoria** y se reporta como
 *    caso incompleto: memoria ausente significa "sin demostrar", no "sin vínculo
 *    anterior".
 * 7. **Idempotente.** `ON CONFLICT ("variant_id") DO NOTHING` sobre candidatos
 *    ya filtrados por memoria ausente. Puede ejecutarse dos veces sin efecto y
 *    no pisa memorias escritas por los handlers.
 *
 * La constancia de los casos no resueltos se emite como informe JSON por
 * consola al ejecutarse. Límite declarado: el proyecto no tiene tabla de
 * incidencias para la reconstrucción y crear una ampliaría el esquema más allá
 * de lo pactado.
 */
export class ReconstructLegacyVariantInventoryMemory1790860800000 implements MigrationInterface {
  /**
   * Forma UUID v4. Filtra identificadores malformados antes de castear a uuid
   * para que un payload corrupto no aborte la migración: se cuenta como
   * evidencia ilegible y la variante queda sin memoria.
   */
  private static readonly uuidV4 =
    '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "legacy_memory_candidates"`);
    await queryRunner.query(`
      CREATE TEMP TABLE "legacy_memory_candidates" (
        "variant_id" uuid NOT NULL,
        "product_id" uuid NOT NULL,
        "inventory_item_id" uuid NOT NULL,
        "source_event_id" uuid NOT NULL,
        "source_server_sequence" bigint,
        PRIMARY KEY ("variant_id", "product_id")
      )
    `);

    await queryRunner.query(`
      INSERT INTO "legacy_memory_candidates" (
        "variant_id",
        "product_id",
        "inventory_item_id",
        "source_event_id",
        "source_server_sequence"
      )
      WITH declaracion AS (
        SELECT
          event."aggregate_id" AS product_id,
          event."event_id" AS event_id,
          event."server_sequence" AS server_sequence,
          entry.value->>'variant_id' AS variant_id,
          entry.value->>'inventory_item_id' AS inventory_item_id,
          0 AS posicion
        FROM "events" AS event
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(event."payload"->'variants') = 'array'
              THEN event."payload"->'variants'
            ELSE '[]'::jsonb
          END
        ) AS entry(value)
        WHERE event."event_type" = 'producto_creado'
          AND event."aggregate_type" = 'product'
          AND event."sync_status" = 'synced'

        UNION ALL

        SELECT
          event."aggregate_id",
          event."event_id",
          event."server_sequence",
          entry.value->>'variant_id',
          entry.value->>'inventory_item_id',
          2
        FROM "events" AS event
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(event."payload"->'after'->'variants') = 'array'
              THEN event."payload"->'after'->'variants'
            ELSE '[]'::jsonb
          END
        ) AS entry(value)
        WHERE event."event_type" = 'producto_actualizado'
          AND event."aggregate_type" = 'product'
          AND event."sync_status" = 'synced'
          AND event."payload"->'delete_product' IS DISTINCT FROM 'true'::jsonb

        UNION ALL

        SELECT
          event."aggregate_id",
          event."event_id",
          event."server_sequence",
          entry.value->>'variant_id',
          entry.value->>'inventory_item_id',
          1
        FROM "events" AS event
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(event."payload"->'before'->'variants') = 'array'
              THEN event."payload"->'before'->'variants'
            ELSE '[]'::jsonb
          END
        ) AS entry(value)
        WHERE event."event_type" = 'producto_actualizado'
          AND event."aggregate_type" = 'product'
          AND event."sync_status" = 'synced'
          AND event."payload"->'delete_product' IS DISTINCT FROM 'true'::jsonb
      ), legible AS (
        SELECT DISTINCT ON (declaracion.variant_id, declaracion.product_id)
          declaracion.*
        FROM declaracion
        WHERE declaracion.variant_id ~* '${ReconstructLegacyVariantInventoryMemory1790860800000.uuidV4}'
          AND declaracion.inventory_item_id ~* '${ReconstructLegacyVariantInventoryMemory1790860800000.uuidV4}'
        ORDER BY
          declaracion.variant_id,
          declaracion.product_id,
          declaracion.server_sequence DESC,
          declaracion.posicion DESC
      )
      SELECT
        legible.variant_id::uuid,
        legible.product_id::uuid,
        legible.inventory_item_id::uuid,
        legible.event_id,
        legible.server_sequence
      FROM legible
      ON CONFLICT ("variant_id", "product_id") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "variant_inventory_memory" (
        "variant_id",
        "inventory_item_id",
        "source_event_id",
        "source_server_sequence"
      )
      SELECT DISTINCT ON (candidato."variant_id")
        candidato."variant_id",
        candidato."inventory_item_id",
        candidato."source_event_id",
        candidato."source_server_sequence"
      FROM "legacy_memory_candidates" AS candidato
      JOIN "product_variants" AS variante
        ON variante."variant_id" = candidato."variant_id"
       AND variante."product_id" = candidato."product_id"
      JOIN "inventory_items" AS recurso
        ON recurso."inventory_item_id" = candidato."inventory_item_id"
      WHERE NOT EXISTS (
        SELECT 1
        FROM "variant_inventory_memory" AS memoria
        WHERE memoria."variant_id" = candidato."variant_id"
      )
      ORDER BY
        candidato."variant_id",
        candidato."source_server_sequence" DESC
      ON CONFLICT ("variant_id") DO NOTHING
    `);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(await this.report(queryRunner)));

    await queryRunner.query(`DROP TABLE "legacy_memory_candidates"`);
  }

  /**
   * Informe de la reconstrucción: qué quedó cubierto y qué sigue sin
   * demostración. Los casos incompletos se nombran, no se inventan.
   */
  private async report(
    queryRunner: QueryRunner,
  ): Promise<Record<string, unknown>> {
    const rows = (await queryRunner.query(`
      SELECT
        jsonb_build_object(
          'migracion', 'ReconstructLegacyVariantInventoryMemory',
          'filas_de_memoria', (
            SELECT COUNT(*) FROM "variant_inventory_memory"
          ),
          'variantes_sin_memoria', (
            SELECT COUNT(*)
            FROM "product_variants" AS variante
            WHERE NOT EXISTS (
              SELECT 1 FROM "variant_inventory_memory" AS memoria
              WHERE memoria."variant_id" = variante."variant_id"
            )
          ),
          'variantes_con_evidencia_incompleta', (
            SELECT COUNT(*)
            FROM "legacy_memory_candidates" AS candidato
            LEFT JOIN "product_variants" AS variante
              ON variante."variant_id" = candidato."variant_id"
             AND variante."product_id" = candidato."product_id"
            LEFT JOIN "inventory_items" AS recurso
              ON recurso."inventory_item_id" = candidato."inventory_item_id"
            WHERE variante."variant_id" IS NULL
               OR recurso."inventory_item_id" IS NULL
          ),
          'variantes_sin_evidencia_demostrable', (
            SELECT COUNT(*)
            FROM "product_variants" AS variante
            WHERE NOT EXISTS (
              SELECT 1 FROM "variant_inventory_memory" AS memoria
              WHERE memoria."variant_id" = variante."variant_id"
            )
            AND NOT EXISTS (
              SELECT 1 FROM "legacy_memory_candidates" AS candidato
              WHERE candidato."variant_id" = variante."variant_id"
            )
          ),
          'ejemplos_de_variantes_sin_memoria', COALESCE((
            SELECT jsonb_agg(sin_memoria."variant_id")
            FROM (
              SELECT variante."variant_id"
              FROM "product_variants" AS variante
              WHERE NOT EXISTS (
                SELECT 1 FROM "variant_inventory_memory" AS memoria
                WHERE memoria."variant_id" = variante."variant_id"
              )
              ORDER BY variante."variant_id"
              LIMIT 50
            ) AS sin_memoria
          ), '[]'::jsonb)
        ) AS reporte
    `)) as Array<{ reporte: Record<string, unknown> }>;
    return rows[0]?.reporte ?? {};
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Sin borrado, y es deliberado. `variant_inventory_memory` es una
    // proyección derivada de `events`: esta migración rellena huecos que los
    // handlers también escriben, y `up` los vuelve a crear con las mismas
    // evidencias. Borrar filas indistinguibles de las que escribió el handler
    // destruiría memoria válida, y esa pérdida no sería recuperable desde este
    // `down`. La corrección es volver a aplicar `up`.
    await queryRunner.query(`DROP TABLE IF EXISTS "legacy_memory_candidates"`);
  }
}
