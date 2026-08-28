import { MigrationInterface, QueryRunner } from 'typeorm';
import { INVENTORY_UNIT_SEED } from '../inventory/inventory-unit-seed';

export class CreateInventoryResources1787140800000 implements MigrationInterface {
  name = 'CreateInventoryResources1787140800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "units" (
        "unit_id" uuid NOT NULL,
        "code" varchar(24) NOT NULL,
        "name" varchar(80) NOT NULL,
        "symbol" varchar(16) NOT NULL,
        "dimension" varchar(16) NOT NULL,
        "atomic_factor" bigint NOT NULL,
        "max_fraction_digits" integer NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "pk_units" PRIMARY KEY ("unit_id"),
        CONSTRAINT "ux_units_code" UNIQUE ("code"),
        CONSTRAINT "ck_units_dimension"
          CHECK ("dimension" IN ('count', 'mass', 'volume')),
        CONSTRAINT "ck_units_atomic_factor" CHECK ("atomic_factor" > 0),
        CONSTRAINT "ck_units_fraction_digits"
          CHECK ("max_fraction_digits" >= 0 AND "max_fraction_digits" <= 9)
      )
    `);

    for (const unit of INVENTORY_UNIT_SEED) {
      await queryRunner.query(
        `
          INSERT INTO "units" (
            "unit_id", "code", "name", "symbol", "dimension",
            "atomic_factor", "max_fraction_digits", "active"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)
          ON CONFLICT ("unit_id") DO UPDATE SET
            "code" = EXCLUDED."code",
            "name" = EXCLUDED."name",
            "symbol" = EXCLUDED."symbol",
            "dimension" = EXCLUDED."dimension",
            "atomic_factor" = EXCLUDED."atomic_factor",
            "max_fraction_digits" = EXCLUDED."max_fraction_digits"
        `,
        [
          unit.unitId,
          unit.code,
          unit.name,
          unit.symbol,
          unit.dimension,
          unit.atomicFactor,
          unit.maxFractionDigits,
        ],
      );
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inventory_items" (
        "inventory_item_id" uuid NOT NULL,
        "default_unit_id" uuid NOT NULL,
        "name" varchar(160) NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "version" integer NOT NULL DEFAULT 1,
        "created_event_id" uuid,
        "last_event_id" uuid,
        "last_server_sequence" bigint,
        "created_at_server" timestamptz(3) NOT NULL DEFAULT now(),
        "updated_at_server" timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT "pk_inventory_items" PRIMARY KEY ("inventory_item_id"),
        CONSTRAINT "fk_inventory_items_default_unit"
          FOREIGN KEY ("default_unit_id") REFERENCES "units"("unit_id")
          ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_inventory_items_active_name"
      ON "inventory_items" ("active", "name", "inventory_item_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_inventory_items_default_unit"
      ON "inventory_items" ("default_unit_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inventory_balances" (
        "inventory_item_id" uuid NOT NULL,
        "quantity_on_hand_atomic" bigint NOT NULL,
        "quantity_available_atomic" bigint NOT NULL,
        "last_event_id" uuid NOT NULL,
        "last_server_sequence" bigint,
        CONSTRAINT "pk_inventory_balances" PRIMARY KEY ("inventory_item_id"),
        CONSTRAINT "fk_inventory_balances_item"
          FOREIGN KEY ("inventory_item_id")
          REFERENCES "inventory_items"("inventory_item_id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inventory_movements" (
        "movement_id" uuid NOT NULL,
        "inventory_item_id" uuid NOT NULL,
        "sale_item_id" uuid,
        "event_id" uuid NOT NULL,
        "reversal_of_movement_id" uuid,
        "movement_type" varchar(40) NOT NULL,
        "quantity_delta_atomic" bigint NOT NULL,
        "total_cost_minor" bigint,
        "reason" varchar(500) NOT NULL,
        "created_at_local" timestamptz(3) NOT NULL,
        "server_sequence" bigint,
        CONSTRAINT "pk_inventory_movements" PRIMARY KEY ("movement_id"),
        CONSTRAINT "ck_inventory_movements_non_zero"
          CHECK ("quantity_delta_atomic" <> 0),
        CONSTRAINT "fk_inventory_movements_item"
          FOREIGN KEY ("inventory_item_id")
          REFERENCES "inventory_items"("inventory_item_id") ON DELETE RESTRICT,
        CONSTRAINT "fk_inventory_movements_reversal"
          FOREIGN KEY ("reversal_of_movement_id")
          REFERENCES "inventory_movements"("movement_id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_inventory_movements_item_created"
      ON "inventory_movements" ("inventory_item_id", "created_at_local")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "inventory_movements"');
    await queryRunner.query('DROP TABLE IF EXISTS "inventory_balances"');
    await queryRunner.query('DROP TABLE IF EXISTS "inventory_items"');
    await queryRunner.query('DROP TABLE IF EXISTS "units"');
  }
}
