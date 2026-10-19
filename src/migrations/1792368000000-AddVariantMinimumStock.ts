import { MigrationInterface, QueryRunner } from 'typeorm';

/** Aditiva: no modifica eventos históricos, vínculos ni saldos. */
export class AddVariantMinimumStock1792368000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      ADD COLUMN IF NOT EXISTS "minimum_stock_atomic" bigint
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "product_variants"."minimum_stock_atomic" IS
      'Umbral en átomos del recurso vinculado, 0..9007199254740991; null desactiva el aviso. Se conserva al desvincular inventario.'
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_product_variants_minimum_stock_range'
            AND conrelid = 'product_variants'::regclass
        ) THEN
          ALTER TABLE "product_variants"
          ADD CONSTRAINT "ck_product_variants_minimum_stock_range"
          CHECK ("minimum_stock_atomic" IS NULL OR
                 "minimum_stock_atomic" BETWEEN 0 AND 9007199254740991);
        END IF;
      END $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Evita pérdida silenciosa de configuración al regresar de versión.
    const configured: unknown[] = await queryRunner.query(
      'SELECT 1 FROM "product_variants" WHERE "minimum_stock_atomic" IS NOT NULL LIMIT 1',
    );
    if (configured.length > 0)
      throw new Error(
        'No se puede retirar minimum_stock_atomic con mínimos configurados.',
      );
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      DROP CONSTRAINT IF EXISTS "ck_product_variants_minimum_stock_range",
      DROP COLUMN IF EXISTS "minimum_stock_atomic"
    `);
  }
}
