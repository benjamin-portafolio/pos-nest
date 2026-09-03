import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRecipeComponents1788264000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "recipe_components" (
        "variant_id" uuid NOT NULL,
        "inventory_item_id" uuid NOT NULL,
        "quantity_atomic" bigint NOT NULL,
        CONSTRAINT "pk_recipe_components"
          PRIMARY KEY ("variant_id", "inventory_item_id"),
        CONSTRAINT "fk_recipe_components_variant"
          FOREIGN KEY ("variant_id")
          REFERENCES "product_variants" ("variant_id")
          ON DELETE CASCADE,
        CONSTRAINT "fk_recipe_components_inventory_item"
          FOREIGN KEY ("inventory_item_id")
          REFERENCES "inventory_items" ("inventory_item_id")
          ON DELETE RESTRICT,
        CONSTRAINT "ck_recipe_components_quantity_atomic"
          CHECK (
            "quantity_atomic" > 0
            AND "quantity_atomic" <= 9007199254740991
          )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_recipe_components_inventory_item"
      ON "recipe_components" ("inventory_item_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "recipe_components"');
  }
}
