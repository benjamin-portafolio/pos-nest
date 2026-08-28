import { RecursoInventarioCreadoPayload } from './recurso-inventario-creado.payload';

describe('RecursoInventarioCreadoPayload', () => {
  it('acepta payload sin movimiento y normaliza NFKC', () => {
    const payload = RecursoInventarioCreadoPayload.fromJson(
      inventoryPayload(null, '  Ｈarina  '),
    );
    expect(payload.name).toBe('Harina');
    expect(payload.initialMovement).toBeNull();
  });

  it.each([250, -250])('acepta delta atómico entero %s', (delta) => {
    const payload = RecursoInventarioCreadoPayload.fromJson(
      inventoryPayload(delta),
    );
    expect(payload.initialMovement?.quantityDeltaAtomic).toBe(delta);
    const json = payload.toJson();
    const movement = json.initial_movement as Record<string, unknown>;
    expect(movement.quantity_delta_atomic).toBe(delta);
  });

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rechaza cantidad inválida %s',
    (delta) => {
      expect(() =>
        RecursoInventarioCreadoPayload.fromJson(inventoryPayload(delta)),
      ).toThrow(/entero seguro distinto de cero/);
    },
  );

  it('rechaza movimiento sin motivo', () => {
    const payload = inventoryPayload(1);
    (payload.initial_movement as Record<string, unknown>).reason = '  ';
    expect(() => RecursoInventarioCreadoPayload.fromJson(payload)).toThrow(
      /reason debe tener entre 1 y 500/,
    );
  });

  it('rechaza UUID inválidos', () => {
    const payload = inventoryPayload(null);
    (payload.inventory_item as Record<string, unknown>).inventory_item_id =
      'no-uuid';
    expect(() => RecursoInventarioCreadoPayload.fromJson(payload)).toThrow(
      /UUID v4/,
    );
  });
});

function inventoryPayload(
  delta: number | null,
  name = 'Harina',
): Record<string, unknown> {
  return {
    inventory_item: {
      inventory_item_id: '20000000-0000-4000-8000-000000000001',
      name,
      default_unit_id: '10000000-0000-4000-8000-000000000003',
    },
    initial_movement:
      delta === null
        ? null
        : {
            movement_id: '30000000-0000-4000-8000-000000000001',
            movement_type: 'manual_adjustment',
            quantity_delta_atomic: delta,
            reason: 'Existencia inicial',
          },
  };
}
