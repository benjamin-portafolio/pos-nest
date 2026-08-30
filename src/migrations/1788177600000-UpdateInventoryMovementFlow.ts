import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateInventoryMovementFlow1788177600000 implements MigrationInterface {
  name = 'UpdateInventoryMovementFlow1788177600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_balances"
      ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      ALTER COLUMN "reason" DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      ADD CONSTRAINT "ck_inventory_movements_reason_shape"
      CHECK (
        "reason" IS NULL OR
        (
          "reason" = btrim("reason") AND
          char_length("reason") BETWEEN 1 AND 500
        )
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      ADD CONSTRAINT "ck_inventory_movements_manual_reason"
      CHECK ("movement_type" <> 'manual_adjustment' OR "reason" IS NOT NULL)
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      ADD CONSTRAINT "ck_inventory_movements_positive_entries"
      CHECK (
        "movement_type" NOT IN ('initial_balance', 'stock_receipt') OR
        "quantity_delta_atomic" > 0
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      ADD CONSTRAINT "ck_inventory_movements_reversal_reference"
      CHECK (
        ("movement_type" = 'reversal') =
        ("reversal_of_movement_id" IS NOT NULL)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      ADD CONSTRAINT "ck_inventory_movements_no_self_reversal"
      CHECK (
        "reversal_of_movement_id" IS NULL OR
        "reversal_of_movement_id" <> "movement_id"
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      DROP CONSTRAINT IF EXISTS "ck_inventory_movements_no_self_reversal",
      DROP CONSTRAINT IF EXISTS "ck_inventory_movements_reversal_reference",
      DROP CONSTRAINT IF EXISTS "ck_inventory_movements_positive_entries",
      DROP CONSTRAINT IF EXISTS "ck_inventory_movements_manual_reason",
      DROP CONSTRAINT IF EXISTS "ck_inventory_movements_reason_shape"
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
      ALTER COLUMN "reason" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_balances"
      DROP COLUMN IF EXISTS "version"
    `);
  }
}
