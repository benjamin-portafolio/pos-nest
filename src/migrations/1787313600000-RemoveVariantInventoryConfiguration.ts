import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveVariantInventoryConfiguration1787313600000 implements MigrationInterface {
  name = 'RemoveVariantInventoryConfiguration1787313600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "recipe_components"');
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ix_product_variants_direct_inventory_item"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "ux_product_variants_direct_inventory_item"
    `);
    await queryRunner.query(`
      ALTER TABLE "product_variants"
      DROP CONSTRAINT IF EXISTS "ck_product_variants_simple_inventory",
      DROP CONSTRAINT IF EXISTS "ck_product_variants_direct_inventory",
      DROP CONSTRAINT IF EXISTS "fk_product_variants_direct_inventory_item",
      DROP COLUMN IF EXISTS "inventory_behavior",
      DROP COLUMN IF EXISTS "inventory_enabled",
      DROP COLUMN IF EXISTS "direct_inventory_item_id",
      DROP COLUMN IF EXISTS "direct_quantity_atomic"
    `);
    await queryRunner.query(`
      ALTER TABLE "products"
      DROP CONSTRAINT IF EXISTS "ck_products_inventory_mode",
      DROP COLUMN IF EXISTS "inventory_mode"
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      DROP CONSTRAINT IF EXISTS "ux_inventory_movements_event"
    `);
  }

  async down(): Promise<void> {
    // La configuración eliminada contenía datos de negocio que no pueden
    // reconstruirse de forma segura durante un rollback.
  }
}
