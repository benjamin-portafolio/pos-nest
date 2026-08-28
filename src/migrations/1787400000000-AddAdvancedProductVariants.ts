import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAdvancedProductVariants1787400000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      ADD COLUMN IF NOT EXISTS "name" varchar(160),
      ADD COLUMN IF NOT EXISTS "name_key" varchar(320),
      ADD COLUMN IF NOT EXISTS "standard_cost_minor" bigint
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_product_variants_standard_cost_non_negative'
            AND conrelid = 'product_variants'::regclass
        ) THEN
          ALTER TABLE "product_variants"
          ADD CONSTRAINT "ck_product_variants_standard_cost_non_negative"
          CHECK (
            "standard_cost_minor" IS NULL OR
            "standard_cost_minor" >= 0
          );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_product_variants_name_key_coherence'
            AND conrelid = 'product_variants'::regclass
        ) THEN
          ALTER TABLE "product_variants"
          ADD CONSTRAINT "ck_product_variants_name_key_coherence"
          CHECK (("name" IS NULL) = ("name_key" IS NULL));
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      "ux_product_variants_product_name_key"
      ON "product_variants" ("product_id", "name_key")
      WHERE "name_key" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE IF EXISTS "event_refs"
      ALTER COLUMN "ref_id" TYPE text
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ux_product_variants_product_name_key"
    `);
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      DROP CONSTRAINT IF EXISTS
        "ck_product_variants_standard_cost_non_negative",
      DROP CONSTRAINT IF EXISTS "ck_product_variants_name_key_coherence",
      DROP COLUMN IF EXISTS "standard_cost_minor",
      DROP COLUMN IF EXISTS "name_key",
      DROP COLUMN IF EXISTS "name"
    `);
  }
}
