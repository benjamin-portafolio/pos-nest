import { InventoryMovementPayload } from './inventory-movement.payload';

describe('InventoryMovementPayload', () => {
  it.each(['initial_balance', 'stock_receipt'] as const)(
    'acepta %s positivo sin motivo',
    (movementType) => {
      const payload = InventoryMovementPayload.fromJson(
        movement({ movement_type: movementType, reason: null }),
      );
      expect(payload.quantityDeltaAtomic).toBe(25);
      expect(payload.reason).toBeNull();
      expect(payload.toJson()).toEqual(
        expect.objectContaining({
          reversal_of_movement_id: null,
          total_cost_minor: null,
        }),
      );
    },
  );

  it('normaliza NFKC y exige motivo para manual_adjustment', () => {
    const payload = InventoryMovementPayload.fromJson(
      movement({
        movement_type: 'manual_adjustment',
        quantity_delta_atomic: -5,
        reason: '  Ｃonteo físico  ',
      }),
    );
    expect(payload.reason).toBe('Conteo físico');

    expect(() =>
      InventoryMovementPayload.fromJson(
        movement({ movement_type: 'manual_adjustment', reason: null }),
      ),
    ).toThrow(/requiere un motivo/);
  });

  it.each([
    { movement_type: 'stock_receipt', quantity_delta_atomic: -1 },
    { movement_type: 'stock_receipt', quantity_delta_atomic: 0 },
    { movement_type: 'initial_balance', quantity_delta_atomic: -1 },
    { movement_type: 'stock_receipt', reason: ' ' },
    { movement_type: 'stock_receipt', total_cost_minor: 100 },
  ])('rechaza combinación inválida %#', (changes) => {
    expect(() =>
      InventoryMovementPayload.fromJson(movement(changes)),
    ).toThrow();
  });

  it('reversal requiere una referencia diferente y los demás tipos la prohíben', () => {
    expect(() =>
      InventoryMovementPayload.fromJson(
        movement({ movement_type: 'reversal', reversal_of_movement_id: null }),
      ),
    ).toThrow(/requiere reversal_of_movement_id/);
    expect(() =>
      InventoryMovementPayload.fromJson(
        movement({
          movement_type: 'reversal',
          reversal_of_movement_id: '30000000-0000-4000-8000-000000000001',
        }),
      ),
    ).toThrow(/sí mismo/);
    expect(() =>
      InventoryMovementPayload.fromJson(
        movement({
          movement_type: 'stock_receipt',
          reversal_of_movement_id: '30000000-0000-4000-8000-000000000002',
        }),
      ),
    ).toThrow(/Solo reversal/);
  });
});

function movement(
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    movement_id: '30000000-0000-4000-8000-000000000001',
    movement_type: 'stock_receipt',
    quantity_delta_atomic: 25,
    reason: null,
    reversal_of_movement_id: null,
    total_cost_minor: null,
    ...changes,
  };
}
