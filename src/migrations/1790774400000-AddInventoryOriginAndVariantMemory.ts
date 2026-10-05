import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fase 1 del plan de seguimiento de existencias (contrato rev. 1 §5).
 *
 * - Agrega `inventory_items.origin_variant_id` nullable, sin fabricar
 *   procedencia y sin editores eventos: la procedencia de los recursos
 *   legados queda en `NULL`, que significa desconocido.
 * - Crea `variant_inventory_memory` con PK por variante, FK en cascada hacia
 *   ambos lados e índice no único por recurso.
 * - Siembra memoria **únicamente** para los vínculos directos actuales,
 *   incluidos los de variantes inactivas, y solo cuando existe un evento de
 *   producto aceptado que acredite ese vínculo. No copia `last_event_id`: podría
 *   apuntar a un evento de Categorías o de otro agregado sin configuración.
 *
 * La reconstrucción de la memoria de variantes ya desvinculadas requiere una
 * cadena demostrable de eventos de producto y corresponde a la fase 2; esta
 * migración no la intenta y no inventa fuentes.
 */
export class AddInventoryOriginAndVariantMemory1790774400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_items"
      ADD COLUMN IF NOT EXISTS "origin_variant_id" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_inventory_items_origin_variant"
      ON "inventory_items" ("origin_variant_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "variant_inventory_memory" (
        "variant_id" uuid NOT NULL,
        "inventory_item_id" uuid NOT NULL,
        "source_event_id" uuid NOT NULL,
        "source_server_sequence" bigint,
        CONSTRAINT "pk_variant_inventory_memory" PRIMARY KEY ("variant_id"),
        CONSTRAINT "fk_variant_inventory_memory_variant"
          FOREIGN KEY ("variant_id")
          REFERENCES "product_variants" ("variant_id")
          ON DELETE CASCADE,
        CONSTRAINT "fk_variant_inventory_memory_inventory_item"
          FOREIGN KEY ("inventory_item_id")
          REFERENCES "inventory_items" ("inventory_item_id")
          ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "variant_inventory_memory" IS
        'Último recurso de inventario directo conocido por una variante. No usa CommonFields: su identidad es la variante y la concurrencia la controla el lock del producto. No reserva existencias ni habilita consumo.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "variant_inventory_memory"."source_event_id" IS
        'Evento de producto que acreditó la memoria; no es FK al historial de eventos.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "variant_inventory_memory"."source_server_sequence" IS
        'Secuencia oficial del evento acreditado; null si el estado es solo local.'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "inventory_items"."origin_variant_id" IS
        'Variante que originó el recurso; identidad, no FK. Null = desconocido.'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_variant_inventory_memory_item"
      ON "variant_inventory_memory" ("inventory_item_id")
    `);

    await this.seedVerifiableMemory(queryRunner);
  }

  /**
   * Siembra una fila por variante con vínculo directo actual cuya procedencia
   * sea demostrable: el evento de producto aceptado más reciente que declaró
   * ese mismo vínculo en el estado resultante (`producto_creado`, o el `after`
   * de un `producto_actualizado` que no elimina el producto).
   *
   * Cuando dos eventos acreditan el mismo vínculo gana el de mayor
   * `server_sequence`, es decir el último en orden causal y no por reloj. Una
   * variante sin evidencia no recibe fila: la memoria ausente significa
   * "sin demostrar", no "sin vínculo anterior".
   */
  private async seedVerifiableMemory(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH acreditaciones AS (
        SELECT
          entry.value->>'variant_id' AS variant_id,
          entry.value->>'inventory_item_id' AS inventory_item_id,
          event."aggregate_id" AS product_id,
          event."event_id" AS event_id,
          event."server_sequence" AS server_sequence
        FROM "events" AS event
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(event."payload"->'variants') = 'array'
              THEN event."payload"->'variants'
            ELSE '[]'::jsonb
          END
        ) AS entry(value)
        WHERE event."event_type" = 'producto_creado'
          AND event."sync_status" = 'synced'
          AND entry.value->>'inventory_item_id' IS NOT NULL

        UNION ALL

        SELECT
          entry.value->>'variant_id' AS variant_id,
          entry.value->>'inventory_item_id' AS inventory_item_id,
          event."aggregate_id" AS product_id,
          event."event_id" AS event_id,
          event."server_sequence" AS server_sequence
        FROM "events" AS event
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(event."payload"->'after'->'variants') = 'array'
              THEN event."payload"->'after'->'variants'
            ELSE '[]'::jsonb
          END
        ) AS entry(value)
        WHERE event."event_type" = 'producto_actualizado'
          AND event."sync_status" = 'synced'
          AND COALESCE(
                (event."payload"->>'delete_product')::boolean, false
              ) = false
          AND entry.value->>'inventory_item_id' IS NOT NULL
      )
      INSERT INTO "variant_inventory_memory" (
        "variant_id",
        "inventory_item_id",
        "source_event_id",
        "source_server_sequence"
      )
      SELECT DISTINCT ON (acreditaciones."variant_id")
        acreditaciones."variant_id"::uuid,
        acreditaciones."inventory_item_id"::uuid,
        acreditaciones."event_id",
        acreditaciones."server_sequence"
      FROM acreditaciones
      JOIN "product_variants" AS variante
        ON variante."variant_id" = acreditaciones."variant_id"::uuid
       AND variante."product_id" = acreditaciones."product_id"
       AND variante."inventory_item_id" =
             acreditaciones."inventory_item_id"::uuid
      WHERE variante."inventory_item_id" IS NOT NULL
      ORDER BY
        acreditaciones."variant_id",
        acreditaciones."server_sequence" DESC
      ON CONFLICT ("variant_id") DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // El downgrade destruye la memoria sembrada y el índice de procedencia.
    // No es una recuperación de datos:Memory y procedencia quedan perdidas y no
    // se pueden reconstruir sin volver a aplicar esta migración con las mismas
    // evidencias.
    await queryRunner.query(`
      DROP TABLE IF EXISTS "variant_inventory_memory"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_inventory_items_origin_variant"
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_items"
      DROP COLUMN IF EXISTS "origin_variant_id"
    `);
  }
}
