import { ProductoCreadoPayload } from './producto-creado.payload';
import { ProductoActualizadoPayload } from './producto-actualizado.payload';
import { supplierFixture } from '../../testing/supplier-contract-fixtures';
const legacy = () => supplierFixture('producto_creado') as any;
const parse = (j: any) => ProductoCreadoPayload.fromJson(j);
describe('S2 configuración de reposición de producto', () => {
  it('conserva ausencia histórica y conoce cero/null con serialización exacta', () => {
    const j = legacy();
    expect((parse(j).toJson() as any).variants[0]).not.toHaveProperty(
      'target_stock_atomic',
    );
    j.variants[0].target_stock_atomic = 0;
    j.variants[0].current_supplier_id = j.variants[0].suppliers[0].supplier_id;
    const p = parse(j);
    expect(p.variants[0].targetStockAtomic).toBe(0);
    expect(parse(p.toJson()).toJson()).toEqual(p.toJson());
    j.variants[0].target_stock_atomic = null;
    j.variants[0].current_supplier_id = null;
    expect((parse(j).toJson() as any).variants[0]).toMatchObject({
      current_supplier_id: null,
      target_stock_atomic: null,
    });
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', NaN, Infinity])(
    'rechaza objetivo %p',
    (value) => {
      const j = legacy();
      j.variants[0].target_stock_atomic = value;
      expect(() => parse(j)).toThrow();
    },
  );
  it('escritor antiguo conserva campos nuevos; base explícita falsa se rechaza', () => {
    const j = legacy(),
      old = parse(j);
    j.variants[0].current_supplier_id = j.variants[0].suppliers[0].supplier_id;
    j.variants[0].target_stock_atomic = 7;
    const current = parse(j);
    expect(ProductoActualizadoPayload.sameEditingBase(current, old)).toBe(true);
    expect(ProductoActualizadoPayload.sameState(current, old)).toBe(false);
    expect(
      () => new ProductoActualizadoPayload('base', current, old),
    ).not.toThrow();
    expect(
      () => new ProductoActualizadoPayload('base', old, current),
    ).toThrow();
    j.variants[0].target_stock_atomic = 8;
    expect(ProductoActualizadoPayload.sameEditingBase(current, parse(j))).toBe(
      false,
    );
  });
  it('UUID inválido no se interpreta como nombre de proveedor', () => {
    const j = legacy();
    j.variants[0].current_supplier_id = 'Proveedor';
    expect(() => parse(j)).toThrow();
  });
});
