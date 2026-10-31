import { readFileSync } from 'fs';
import { join } from 'path';
import { ProductoCreadoPayload } from './producto-creado.payload';
import { ProductoActualizadoPayload } from './producto-actualizado.payload';
import { VentaConfirmadaPayload } from './venta-confirmada.payload';
const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '../../../contracts/offer_pricing/v2.json'),
    'utf8',
  ),
);
const value = (key: string) => structuredClone(fixtures[key]);
describe('Oferta: fixtures compartidos Flutter/NestJS', () => {
  it.each(['product', 'product_null', 'product_legacy'])(
    '%s conserva presencia sin promover eventos históricos',
    (key) => {
      const p = ProductoCreadoPayload.fromJson(value(key));
      const again = ProductoCreadoPayload.fromJson(p.toJson());
      expect(again.knowsOfferPrice).toBe(key !== 'product_legacy');
      expect(again.toJson()).toEqual(p.toJson());
    },
  );
  it('promueve ausencia a null solo en base acreditada, sin retroceso', () => {
    const old = ProductoCreadoPayload.fromJson(value('product_legacy')),
      known = ProductoCreadoPayload.fromJson(value('product_null'));
    expect(ProductoActualizadoPayload.sameEditingBase(old, known)).toBe(true);
    expect(ProductoActualizadoPayload.sameEditingBase(known, old)).toBe(false);
  });
  it.each(fixtures.invalid_offers)('rechaza oferta %s', (v) => {
    const j = value('product');
    j.variants[0].offer_price_minor = v;
    expect(() => ProductoCreadoPayload.fromJson(j)).toThrow();
  });
  it('rechaza presencia parcial entre variantes', () => {
    const j = value('product');
    j.variants.push({
      ...value('product_legacy').variants[0],
      variant_id: '00000000-0000-4000-8000-000000000099',
      sort_order: 1,
    });
    expect(() => ProductoCreadoPayload.fromJson(j)).toThrow('parcial');
  });
  it.each(['sale', 'sale_legacy'])(
    '%s conserva snapshot y contrato conocido o ausente',
    (key) => {
      const p = VentaConfirmadaPayload.fromJson(value(key));
      expect(VentaConfirmadaPayload.fromJson(p.toJson()).toJson()).toEqual(
        p.toJson(),
      );
      expect(p.pricingContractVersion).toBe(key === 'sale' ? 2 : null);
    },
  );
  for (const [field, invalids] of Object.entries(
    fixtures.invalid_snapshot_fields,
  )) {
    it.each(invalids as unknown[])(`rechaza ${field}=%s`, (v) => {
      const j = value('sale');
      j.lines[0].snapshot[field] = v;
      expect(() => VentaConfirmadaPayload.fromJson(j)).toThrow();
    });
  }
  it('venta mixta mantiene línea legada sin inventar alternativas', () => {
    const j = value('sale'),
      line = value('sale_legacy').lines[0];
    line.sale_item_id = '00000000-0000-4000-8000-000000000098';
    j.lines.push(line);
    j.total_minor = 8000;
    j.received_minor = 10000;
    j.change_minor = j.received_minor - j.total_minor;
    const p = VentaConfirmadaPayload.fromJson(j);
    expect(p.lines[1].snapshot.price_snapshot_version).toBeUndefined();
    expect(p.lines[0].snapshot.price_snapshot_version).toBe(2);
  });
  it('no permite omitir ningún campo v2 ni el contrato global/dependencia', () => {
    for (const field of Object.keys(fixtures.invalid_snapshot_fields)) {
      const j = value('sale');
      delete j.lines[0].snapshot[field];
      expect(() => VentaConfirmadaPayload.fromJson(j)).toThrow();
    }
    const j = value('sale');
    delete j.pricing_contract_version;
    expect(() => VentaConfirmadaPayload.fromJson(j)).toThrow();
    const d = value('sale');
    d.dependency_event_ids = d.dependency_event_ids.slice(1);
    expect(() => VentaConfirmadaPayload.fromJson(d)).toThrow();
  });
});
