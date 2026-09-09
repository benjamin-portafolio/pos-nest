import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddActiveVariantUniqueness1788912000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "ux_product_variants_product_sort"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ux_product_variants_product_sort"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ux_product_variants_product_name_key"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_product_variants_product_sort" ON "product_variants" ("product_id", "sort_order") WHERE "active" = true`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_product_variants_product_name_key" ON "product_variants" ("product_id", "name_key") WHERE "active" = true AND "name_key" IS NOT NULL`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    // PostgreSQL rejects rollback if archived rows now share a name/order;
    // do not destroy their historical values to force a downgrade.
    await queryRunner.query(`DROP INDEX "ux_product_variants_product_sort"`);
    await queryRunner.query(
      `DROP INDEX "ux_product_variants_product_name_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "ux_product_variants_product_sort" UNIQUE ("product_id", "sort_order")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_product_variants_product_name_key" ON "product_variants" ("product_id", "name_key") WHERE "name_key" IS NOT NULL`,
    );
  }
}
