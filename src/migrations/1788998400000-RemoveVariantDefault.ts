import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveVariantDefault1788998400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN IF EXISTS "is_default"`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD COLUMN "is_default" boolean NOT NULL DEFAULT false`,
    );
    // Reconstruct the former rule from active order; the removed flags are not recoverable.
    await queryRunner.query(`
      UPDATE "product_variants" SET "is_default" = true
      WHERE "variant_id" IN (
        SELECT DISTINCT ON ("product_id") "variant_id"
        FROM "product_variants" WHERE "active" = true
        ORDER BY "product_id", "sort_order", "variant_id"
      )
    `);
    await queryRunner.query(
      `ALTER TABLE "product_variants" ALTER COLUMN "is_default" DROP DEFAULT`,
    );
  }
}
