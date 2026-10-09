import { MigrationInterface, QueryRunner } from 'typeorm';

/** Aditiva: no modifica eventos/productos ni inventa relaciones. */
export class CreateProductSuppliers1791417600000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE IF NOT EXISTS "suppliers" (
      "supplier_id" uuid PRIMARY KEY,
      "name" text NOT NULL,
      "phone" text,
      "notes" text,
      "active" boolean NOT NULL DEFAULT true,
      "version" integer NOT NULL DEFAULT 1,
      "created_event_id" uuid,
      "last_event_id" uuid,
      "last_server_sequence" bigint,
      "created_at_server" timestamptz(3) NOT NULL DEFAULT now(),
      "updated_at_server" timestamptz(3) NOT NULL DEFAULT now(),
      CONSTRAINT "ck_suppliers_name" CHECK (length(btrim(name, E' \t\n\r')) > 0)
    )`);
    await runner.query(`CREATE TABLE IF NOT EXISTS "variant_suppliers" (
      "variant_id" uuid NOT NULL,
      "supplier_id" uuid NOT NULL,
      "quoted_price_minor" bigint NOT NULL,
      "quoted_at_ms" bigint NOT NULL,
      CONSTRAINT "pk_variant_suppliers" PRIMARY KEY ("variant_id", "supplier_id"),
      CONSTRAINT "fk_variant_suppliers_variant" FOREIGN KEY ("variant_id") REFERENCES "product_variants" ("variant_id") ON DELETE CASCADE,
      CONSTRAINT "fk_variant_suppliers_supplier" FOREIGN KEY ("supplier_id") REFERENCES "suppliers" ("supplier_id") ON DELETE RESTRICT,
      CONSTRAINT "ck_variant_suppliers_price" CHECK ("quoted_price_minor" BETWEEN 0 AND 9007199254740991),
      CONSTRAINT "ck_variant_suppliers_date" CHECK ("quoted_at_ms" BETWEEN 1 AND 9007199254740991)
    )`);
  }
  async down(runner: QueryRunner): Promise<void> {
    const [row] = await runner.query(
      `SELECT EXISTS(SELECT 1 FROM "suppliers") OR EXISTS(SELECT 1 FROM "variant_suppliers") AS populated`,
    );
    if (row.populated)
      throw new Error(
        'No se puede retirar el esquema con proveedores o precios guardados.',
      );
    await runner.query('DROP TABLE "variant_suppliers"');
    await runner.query('DROP TABLE "suppliers"');
  }
}
