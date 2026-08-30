import { MovimientoInventarioRegistradoPayload } from './movimiento-inventario-registrado.payload';
import { RecursoInventarioActualizadoPayload } from './recurso-inventario-actualizado.payload';

describe('payloads mutables de inventario', () => {
  it('actualiza únicamente name y normaliza NFKC', () => {
    const payload = RecursoInventarioActualizadoPayload.fromJson({
      base_event_id: 'event-base',
      changed_fields: ['name'],
      changes: { name: { from: 'Harina', to: '  Ｈarina integral ' } },
    });
    expect(payload.nextName).toBe('Harina integral');
    expect(payload.toJson()).not.toHaveProperty('default_unit_id');
  });

  it('rechaza campos mutables distintos del nombre', () => {
    expect(() =>
      RecursoInventarioActualizadoPayload.fromJson({
        base_event_id: 'event-base',
        changed_fields: ['default_unit_id'],
        changes: { default_unit_id: { from: 'a', to: 'b' } },
      }),
    ).toThrow(/solo admite/);

    expect(() =>
      RecursoInventarioActualizadoPayload.fromJson({
        base_event_id: 'event-base',
        changed_fields: ['name'],
        changes: { name: { from: 'Harina', to: 'Harina integral' } },
        default_unit_id: '10000000-0000-4000-8000-000000000004',
      }),
    ).toThrow(/campos no permitidos/);
  });

  it('decodifica un stock_receipt sin motivo', () => {
    const payload = MovimientoInventarioRegistradoPayload.fromJson({
      base_event_id: 'event-base',
      movement: {
        movement_id: '30000000-0000-4000-8000-000000000001',
        movement_type: 'stock_receipt',
        quantity_delta_atomic: 10,
        reason: null,
        reversal_of_movement_id: null,
        total_cost_minor: null,
      },
    });
    expect(payload.movement.reason).toBeNull();
    expect(payload.movement.quantityDeltaAtomic).toBe(10);
  });
});
