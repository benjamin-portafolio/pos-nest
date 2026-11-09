import { RecursoInventarioEliminadoPayload as Payload } from './recurso-inventario-eliminado.payload';

describe('RecursoInventarioEliminadoPayload', () => {
  it('normaliza y serializa la base sin opciones de borrado físico', () => {
    expect(Payload.fromJson({ base_event_id: ' base ' }).toJson()).toEqual({
      base_event_id: 'base',
    });
  });
  it.each([
    {},
    { base_event_id: '' },
    { base_event_id: 1 },
    { base_event_id: 'base', force: true },
  ])('rechaza contrato inválido %j', (payload) => {
    expect(() => Payload.fromJson(payload)).toThrow();
  });
});
