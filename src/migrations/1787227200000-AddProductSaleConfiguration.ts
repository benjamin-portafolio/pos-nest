import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProductSaleConfiguration1787227200000 implements MigrationInterface {
  name = 'AddProductSaleConfiguration1787227200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "products"
      ADD COLUMN IF NOT EXISTS "sale_mode" varchar(16) NOT NULL DEFAULT 'unit',
      ADD COLUMN IF NOT EXISTS "sale_unit_id" uuid,
      ADD COLUMN IF NOT EXISTS "price_reference_quantity_atomic" bigint
    `);
    await queryRunner.query(`
      UPDATE "products"
      SET "sale_mode" = 'unit',
          "sale_unit_id" = NULL,
          "price_reference_quantity_atomic" = NULL
      WHERE "sale_mode" <> 'measured'
         OR "sale_unit_id" IS NULL
         OR "price_reference_quantity_atomic" IS NULL
         OR "price_reference_quantity_atomic" <= 0
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "products"
        ADD CONSTRAINT "fk_products_sale_unit"
        FOREIGN KEY ("sale_unit_id") REFERENCES "units"("unit_id")
        ON DELETE RESTRICT;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "products"
        ADD CONSTRAINT "ck_products_sale_mode"
        CHECK ("sale_mode" IN ('unit', 'measured'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "products"
        ADD CONSTRAINT "ck_products_sale_configuration"
        CHECK (
          ("sale_mode" = 'unit' AND "sale_unit_id" IS NULL AND
            "price_reference_quantity_atomic" IS NULL) OR
          ("sale_mode" = 'measured' AND "sale_unit_id" IS NOT NULL AND
            "price_reference_quantity_atomic" > 0)
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_products_sale_unit"
      ON "products" ("sale_unit_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "ix_products_sale_unit"');
    await queryRunner.query(`
      ALTER TABLE "products"
      DROP CONSTRAINT IF EXISTS "ck_products_sale_configuration",
      DROP CONSTRAINT IF EXISTS "ck_products_sale_mode",
      DROP CONSTRAINT IF EXISTS "fk_products_sale_unit",
      DROP COLUMN IF EXISTS "price_reference_quantity_atomic",
      DROP COLUMN IF EXISTS "sale_unit_id",
      DROP COLUMN IF EXISTS "sale_mode"
    `);
  }
}
