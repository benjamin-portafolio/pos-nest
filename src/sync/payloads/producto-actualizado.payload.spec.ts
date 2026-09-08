import { ProductoActualizadoPayload } from './producto-actualizado.payload';
const id = '00000000-0000-4000-8000-000000000001';
const state = () => ({
  product: {
    name: 'Café',
    category_id: null,
    sale_configuration: { mode: 'unit' },
  },
  variants: [
    {
      variant_id: id,
      name: null,
      sale_price_minor: 1000,
      standard_cost_minor: null,
      is_default: true,
      sort_order: 0,
    },
  ],
  dependencies: [] as Record<string, unknown>[],
});
describe('ProductoActualizadoPayload', () => {
  it('normaliza cambios y conserva null para quitar costo', () => {
    const before = state();
    const after = state();
    after.product.name = '  Nuevo  ';
    const result = ProductoActualizadoPayload.fromJson({
      base_event_id: id,
      before,
      after,
    });
    expect(result.after.name).toBe('Nuevo');
    expect(
      ProductoActualizadoPayload.fromJson(result.toJson()).after.variants[0]
        .standardCostMinor,
    ).toBeNull();
  });
  it('rechaza cambios de forma de venta', () => {
    const after: Record<string, unknown> = state();
    after.product = {
      name: 'Café',
      sale_configuration: {
        mode: 'measured',
        sale_unit_id: id,
        price_reference_quantity_atomic: 1000,
      },
    };
    after.dependencies = [{ ref_type: 'unit', ref_id: id }];
    expect(() =>
      ProductoActualizadoPayload.fromJson({
        base_event_id: id,
        before: state(),
        after,
      }),
    ).toThrow('forma de venta');
  });
  it('rechaza altas o sustituciones de variantes y bases inválidas', () => {
    const after = state();
    after.variants[0].variant_id = '00000000-0000-4000-8000-000000000002';
    expect(() =>
      ProductoActualizadoPayload.fromJson({
        base_event_id: id,
        before: state(),
        after,
      }),
    ).toThrow('variantes existentes');
    expect(() =>
      ProductoActualizadoPayload.fromJson({
        base_event_id: '',
        before: state(),
        after: state(),
      }),
    ).toThrow('base');
  });
});
