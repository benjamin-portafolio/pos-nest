import { randomUUID } from 'crypto';
import { VentaConfirmadaPayload } from './venta-confirmada.payload';

function legacy() {
  const config = randomUUID();
  return {
    payment_id: randomUUID(),
    payment_method: 'cash',
    currency: 'MXN',
    total_minor: 10000,
    received_minor: 20000,
    change_minor: 10000,
    dependency_event_ids: [config],
    lines: [
      {
        sale_item_id: randomUUID(),
        product_id: randomUUID(),
        configuration_event_id: config,
        consumption_mode: 'none',
        sale_unit_id: null,
        consumptions: [],
        snapshot: {
          variant_id: randomUUID(),
          product_name_snapshot: 'Café',
          variant_name_snapshot: null,
          sale_mode_snapshot: 'unit',
          quantity: 1,
          measured_quantity_atomic: null,
          unit_price_minor: 10000,
          standard_cost_minor_snapshot: null,
          price_reference_quantity_atomic_snapshot: null,
          sale_unit_code_snapshot: null,
          sale_unit_symbol_snapshot: null,
          sale_unit_atomic_factor_snapshot: null,
        },
      },
    ],
  };
}
describe('VentaConfirmadaPayload transfer', () => {
  it('conserva cero canónico cuando un consumo de receta redondea a cero', () => {
    const sale = legacy();
    const [line] = sale.lines;
    const payload = VentaConfirmadaPayload.fromJson({
      ...sale,
      lines: [
        {
          ...line,
          consumption_mode: 'recipe',
          sale_unit_id: randomUUID(),
          consumptions: [
            {
              inventory_item_id: randomUUID(),
              component_atomic: 1,
              quantity_delta_atomic: 0,
              movement_type: 'sale_consumption',
              total_cost_minor: null,
              movement_id: null,
            },
          ],
          snapshot: {
            ...line.snapshot,
            sale_mode_snapshot: 'measured',
            quantity: null,
            measured_quantity_atomic: 1,
            unit_price_minor: 1000000,
            price_reference_quantity_atomic_snapshot: 100,
            sale_unit_code_snapshot: 'g',
            sale_unit_symbol_snapshot: 'g',
            sale_unit_atomic_factor_snapshot: 1,
          },
        },
      ],
    });
    expect(payload.lines[0].consumptions[0].quantity_delta_atomic).toBe(0);
  });
  it('lee efectivo legado sin referencia y conserva cambio', () => {
    const p = VentaConfirmadaPayload.fromJson(legacy());
    expect(p.paymentMethod).toBe('cash');
    expect(p.paymentReference).toBeNull();
    expect(p.changeMinor).toBe(10000);
    expect(
      VentaConfirmadaPayload.fromJson(p.toJson()).paymentReference,
    ).toBeNull();
  });
  it.each([undefined, null, '', '  ', '  BANK-1  ', 'x'.repeat(500)])(
    'normaliza %s',
    (reference) => {
      const p = VentaConfirmadaPayload.fromJson({
        ...legacy(),
        payment_method: 'transfer',
        received_minor: 10000,
        change_minor: 0,
        payment_reference: reference,
      });
      expect(p.paymentReference).toBe(reference?.trim() || null);
      expect(VentaConfirmadaPayload.fromJson(p.toJson()).paymentReference).toBe(
        p.paymentReference,
      );
    },
  );
  it.each([
    { payment_method: 'card' },
    { received_minor: 10001, change_minor: 1 },
    { received_minor: 9999 },
    { change_minor: 1 },
    { change_minor: -1 },
    { total_minor: 10 },
    { received_minor: 10.5 },
    { received_minor: Number.MAX_SAFE_INTEGER + 1 },
    { payment_reference: 45 },
    { payment_reference: 'x'.repeat(501) },
    { payment_id: null },
    { currency: 'USD' },
  ])('rechaza %j', (patch) => {
    expect(() =>
      VentaConfirmadaPayload.fromJson({
        ...legacy(),
        payment_method: 'transfer',
        received_minor: 10000,
        change_minor: 0,
        ...patch,
      }),
    ).toThrow();
  });
});
