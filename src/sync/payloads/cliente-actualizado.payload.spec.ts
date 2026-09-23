import { randomUUID } from 'crypto';
import { ClienteActualizadoPayload } from './cliente-actualizado.payload';

describe('ClienteActualizadoPayload', () => {
  const json = {
    base_event_id: randomUUID(),
    before: { nombre: ' Ana ', telefono: ' 001 ' },
    after: { nombre: ' Nueva ', telefono: ' ' },
  };
  it('normaliza y conserva el contrato de ida y vuelta', () => {
    const payload = ClienteActualizadoPayload.fromJson(json);
    expect(payload.toJson()).toEqual({
      ...json,
      before: { nombre: 'Ana', telefono: '001' },
      after: { nombre: 'Nueva', telefono: null },
    });
    expect(
      ClienteActualizadoPayload.fromJson(payload.toJson()).toJson(),
    ).toEqual(payload.toJson());
  });
  it.each([
    { ...json, base_event_id: '' },
    { ...json, before: null },
    { ...json, after: [] },
    { ...json, after: { nombre: ' ' } },
    { ...json, after: { nombre: 'Ana', telefono: 123 } },
  ])('rechaza entradas inválidas %p', (input) => {
    expect(() => ClienteActualizadoPayload.fromJson(input)).toThrow();
  });
});
