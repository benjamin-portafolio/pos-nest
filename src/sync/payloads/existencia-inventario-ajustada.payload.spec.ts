import { ExistenciaInventarioAjustadaPayload } from './existencia-inventario-ajustada.payload';

describe('ExistenciaInventarioAjustadaPayload', () => {
  it('normaliza y serializa el contrato enviado por Flutter', () => {
    const payload = ExistenciaInventarioAjustadaPayload.fromJson({
      inventory_item_id: '20000000-0000-4000-8000-000000000001',
      movement: {
        movement_id: '30000000-0000-4000-8000-000000000001',
        movement_type: 'manual_adjustment',
        quantity_delta_atomic: -125,
        reason: '  Merma por rotura  ',
      },
    });

    expect(payload.inventoryItemId).toBe(
      '20000000-0000-4000-8000-000000000001',
    );
    expect(payload.movement.quantityDeltaAtomic).toBe(-125);
    expect(payload.toJson()).toEqual({
      inventory_item_id: '20000000-0000-4000-8000-000000000001',
      movement: {
        movement_id: '30000000-0000-4000-8000-000000000001',
        movement_type: 'manual_adjustment',
        quantity_delta_atomic: -125,
        reason: 'Merma por rotura',
      },
    });
  });

  it.each([
    [0, 'entero seguro distinto de cero'],
    [1.5, 'entero seguro distinto de cero'],
    [Number.MAX_SAFE_INTEGER + 1, 'entero seguro distinto de cero'],
  ])('rechaza cantidad inválida %s', (quantity, expectedMessage) => {
    expect(() =>
      ExistenciaInventarioAjustadaPayload.fromJson(
        validPayload({ quantity_delta_atomic: quantity }),
      ),
    ).toThrow(expectedMessage);
  });

  it('rechaza movimiento, UUID y motivo inválidos', () => {
    expect(() =>
      ExistenciaInventarioAjustadaPayload.fromJson(
        validPayload({ movement_type: 'sale' }),
      ),
    ).toThrow('manual_adjustment');
    expect(() =>
      ExistenciaInventarioAjustadaPayload.fromJson({
        ...validPayload(),
        inventory_item_id: 'item-1',
      }),
    ).toThrow('UUID v4');
    expect(() =>
      ExistenciaInventarioAjustadaPayload.fromJson(
        validPayload({ reason: '  ' }),
      ),
    ).toThrow('entre 1 y 500');
  });
});

function validPayload(
  movementOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    inventory_item_id: '20000000-0000-4000-8000-000000000001',
    movement: {
      movement_id: '30000000-0000-4000-8000-000000000001',
      movement_type: 'manual_adjustment',
      quantity_delta_atomic: 250,
      reason: 'Conteo físico',
      ...movementOverrides,
    },
  };
}
