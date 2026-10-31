import { MigrationInterface, QueryRunner } from 'typeorm';

/** Aditiva; los snapshots históricos JSONB y los eventos permanecen intactos. */
export class AddOfferPricing1793404800000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    for (const [table, column, type] of [
      ['product_variants', 'offer_price_minor', 'bigint'],
      ['sales', 'pricing_contract_version', 'integer'],
      ['sales', 'pricing_mode', 'character varying'],
    ]) {
      const columns: { type: string; required: boolean }[] = await q.query(
        `SELECT format_type(atttypid, atttypmod) AS type, attnotnull AS required FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2 AND NOT attisdropped`,
        [table, column],
      );
      if (columns.length && (columns[0].type !== type || columns[0].required))
        throw new Error(
          `Esquema previo incompatible para ${table}.${column}; conservar datos y revisar migración.`,
        );
    }

    await q.query(
      'ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS offer_price_minor bigint',
    );
    await q.query(
      'ALTER TABLE sales ADD COLUMN IF NOT EXISTS pricing_contract_version integer, ADD COLUMN IF NOT EXISTS pricing_mode varchar',
    );
    await q.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_product_variants_offer_price' AND conrelid='product_variants'::regclass) THEN
        ALTER TABLE product_variants ADD CONSTRAINT ck_product_variants_offer_price CHECK (offer_price_minor IS NULL OR (offer_price_minor BETWEEN 1 AND 9007199254740991 AND offer_price_minor <= sale_price_minor));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ck_sales_pricing' AND conrelid='sales'::regclass) THEN
        ALTER TABLE sales ADD CONSTRAINT ck_sales_pricing CHECK ((pricing_contract_version IS NULL AND pricing_mode IS NULL) OR (pricing_contract_version IS NOT NULL AND pricing_contract_version=2 AND pricing_mode IS NOT NULL AND pricing_mode IN ('normal','offer')));
      END IF;
    END $$`);
  }
  async down(_q: QueryRunner): Promise<void> {
    throw new Error(
      'No se admite downgrade destructivo de oferta; conservar esquema y datos.',
    );
  }
}
