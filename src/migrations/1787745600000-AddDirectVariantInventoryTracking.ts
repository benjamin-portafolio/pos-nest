import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDirectVariantInventoryTracking1787745600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      ADD COLUMN IF NOT EXISTS "inventory_item_id" uuid
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'fk_product_variants_inventory_item'
            AND conrelid = 'product_variants'::regclass
        ) THEN
          ALTER TABLE "product_variants"
          ADD CONSTRAINT "fk_product_variants_inventory_item"
          FOREIGN KEY ("inventory_item_id")
          REFERENCES "inventory_items" ("inventory_item_id")
          ON DELETE RESTRICT;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      "ux_product_variants_inventory_item"
      ON "product_variants" ("inventory_item_id")
      WHERE "inventory_item_id" IS NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ux_product_variants_inventory_item"
    `);
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      DROP CONSTRAINT IF EXISTS "fk_product_variants_inventory_item",
      DROP COLUMN IF EXISTS "inventory_item_id"
    `);
  }
}
