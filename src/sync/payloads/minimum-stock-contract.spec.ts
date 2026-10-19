import { readFileSync } from 'fs';
import { join } from 'path';
import { ProductoCreadoPayload } from './producto-creado.payload';
import { ProductoActualizadoPayload } from './producto-actualizado.payload';

const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '../../../test/fixtures/minimum_stock_v1/contracts.json'),
    'utf8',
  ),
) as {
  creations: {
    name: string;
    valid: boolean;
    payload: Record<string, unknown>;
  }[];
  updates: { name: string; valid: boolean; payload: Record<string, unknown> }[];
  comparisons: {
    name: string;
    current: Record<string, unknown>;
    before: Record<string, unknown>;
    same_state: boolean;
    same_base: boolean;
  }[];
};
describe('minimum_stock_atomic: contratos equivalentes Dart/TypeScript', () => {
  for (const fixture of fixtures.creations) {
    it(`alta: ${fixture.name}`, () => {
      if (!fixture.valid) {
        expect(() => ProductoCreadoPayload.fromJson(fixture.payload)).toThrow();
        return;
      }
      const parsed = ProductoCreadoPayload.fromJson(fixture.payload);
      expect(parsed.toJson()).toEqual(fixture.payload);
      expect(ProductoCreadoPayload.fromJson(parsed.toJson()).toJson()).toEqual(
        fixture.payload,
      );
      expect(ProductoCreadoPayload.knowsMinimumStockJson(fixture.payload)).toBe(
        parsed.knowsMinimumStock,
      );
      expect(parsed.withKnownSuppliers().knowsMinimumStock).toBe(
        parsed.knowsMinimumStock,
      );
      expect(
        parsed.withKnownSuppliers().variants.map((v) => v.minimumStockAtomic),
      ).toEqual(parsed.variants.map((v) => v.minimumStockAtomic));
      expect(
        parsed.withKnownMinimumStock().variants.map((v) => v.suppliers),
      ).toEqual(parsed.variants.map((v) => v.suppliers));
    });
  }
  for (const fixture of fixtures.updates) {
    it(`edición: ${fixture.name}`, () => {
      if (!fixture.valid)
        expect(() =>
          ProductoActualizadoPayload.fromJson(fixture.payload),
        ).toThrow();
      else
        expect(
          ProductoActualizadoPayload.fromJson(fixture.payload).toJson(),
        ).toEqual(fixture.payload);
    });
  }
  for (const fixture of fixtures.comparisons) {
    it(`base: ${fixture.name}`, () => {
      const current = ProductoCreadoPayload.fromJson(fixture.current);
      const before = ProductoCreadoPayload.fromJson(fixture.before);
      expect(ProductoActualizadoPayload.sameState(current, before)).toBe(
        fixture.same_state,
      );
      expect(ProductoActualizadoPayload.sameEditingBase(current, before)).toBe(
        fixture.same_base,
      );
    });
  }
  it('constructores anteriores conservan ausencia y la promoción no cambia negocio', () => {
    const legacy = ProductoCreadoPayload.fromJson(
      fixtures.creations[0].payload,
    );
    const copy = new ProductoCreadoPayload(
      legacy.name,
      legacy.categoryId,
      legacy.saleConfiguration,
      legacy.variants,
      legacy.categoryDependency,
      legacy.inventoryDependencies,
    );
    expect(copy.knowsMinimumStock).toBe(false);
    expect(copy.toJson()).toEqual(legacy.toJson());
    expect(copy.withKnownMinimumStock().knowsMinimumStock).toBe(true);
    expect(
      ProductoActualizadoPayload.sameState(copy, copy.withKnownMinimumStock()),
    ).toBe(true);
    expect(
      ProductoActualizadoPayload.sameEditingBase(
        copy.withKnownMinimumStock(),
        copy,
      ),
    ).toBe(false);
  });
  for (const value of [NaN, Infinity, -Infinity, undefined]) {
    it(`rechaza campo presente inválido ${value}`, () => {
      const json = structuredClone(fixtures.creations[0].payload);
      (json.variants as Record<string, unknown>[]).forEach((v) => {
        v.minimum_stock_atomic = value;
      });
      expect(() => ProductoCreadoPayload.fromJson(json)).toThrow();
    });
  }
  it('constructor tipado valida rango y snapshots parciales sin pasar por JSON', () => {
    const legacy = ProductoCreadoPayload.fromJson(
      fixtures.creations[0].payload,
    );
    for (const value of [-1, 9007199254740992, 1.5, NaN]) {
      expect(
        () =>
          new ProductoCreadoPayload(
            legacy.name,
            legacy.categoryId,
            legacy.saleConfiguration,
            legacy.variants.map((v) => ({ ...v, minimumStockAtomic: value })),
            null,
            [],
          ),
      ).toThrow();
    }
    expect(
      () =>
        new ProductoCreadoPayload(
          legacy.name,
          legacy.categoryId,
          legacy.saleConfiguration,
          legacy.variants.map((v, i) =>
            i === 0 ? { ...v, minimumStockAtomic: null } : v,
          ),
          null,
          [],
        ),
    ).toThrow();
  });
});
