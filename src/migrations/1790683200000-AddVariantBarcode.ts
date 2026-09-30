import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVariantBarcode1790683200000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      ADD COLUMN IF NOT EXISTS "barcode" varchar(32)
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_product_variants_barcode_digits'
            AND conrelid = 'product_variants'::regclass
        ) THEN
          ALTER TABLE "product_variants"
          ADD CONSTRAINT "ck_product_variants_barcode_digits"
          CHECK ("barcode" IS NULL OR "barcode" ~ '^[0-9]{1,32}$');
        END IF;
      END
      $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      DROP CONSTRAINT IF EXISTS "ck_product_variants_barcode_digits",
      DROP COLUMN IF EXISTS "barcode"
    `);
  }
}
