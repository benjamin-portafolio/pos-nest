import { ClienteCreadoPayload } from './cliente-creado.payload';
describe('ClienteCreadoPayload', () => {
  it('normaliza nombre y teléfono conservando prefijos y ceros', () => {
    expect(
      ClienteCreadoPayload.fromJson({
        nombre: ' Ana ',
        telefono: ' +52 00123 ',
      }).toJson(),
    ).toEqual({ nombre: 'Ana', telefono: '+52 00123' });
  });
  it.each([undefined, null, '', '   '])(
    'acepta teléfono opcional %p',
    (telefono) => {
      expect(
        ClienteCreadoPayload.fromJson({ nombre: 'Ana', telefono }).telefono,
      ).toBeNull();
    },
  );
  it.each([undefined, null, '', ' ', 123, {}, []])(
    'rechaza nombre inválido %p',
    (nombre) => {
      expect(() => ClienteCreadoPayload.fromJson({ nombre })).toThrow();
    },
  );
  it.each([123, {}, [], true])('rechaza teléfono no textual %p', (telefono) => {
    expect(() =>
      ClienteCreadoPayload.fromJson({ nombre: 'Ana', telefono }),
    ).toThrow();
  });
});
