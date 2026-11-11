import { MigrationInterface, QueryRunner } from 'typeorm';

export class AlignOfferPricingComment1794268800000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`COMMENT ON COLUMN product_variants.offer_price_minor IS 'Oferta opcional; no modifica costo ni acredita presencia histórica.'`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('COMMENT ON COLUMN product_variants.offer_price_minor IS NULL');
  }
}
