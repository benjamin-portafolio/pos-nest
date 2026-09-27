import { CategoriaFinancieraCreadaPayload } from './categoria-financiera-creada.payload';
import { readFinancialFixture } from '../../testing/financial-fixtures';

describe('CategoriaFinancieraCreadaPayload (fixtures del contrato)', () => {
  it.each([
    ['payload-renta-valid.json', 'Renta', 'out', 'operating'],
    ['payload-aportacion-valid.json', 'Aportaciones', 'in', 'capital'],
    ['payload-nombre-100-valid.json', 'C'.repeat(100), 'out', 'operating'],
  ] as const)(
    '%s se parsea y serializa canónicamente',
    (file, name, direction, nature) => {
      const parsed = CategoriaFinancieraCreadaPayload.fromJson(
        readFinancialFixture(`categoria_financiera/${file}`),
      );

      expect(parsed.name).toBe(name);
      expect(parsed.direction).toBe(direction);
      expect(parsed.nature).toBe(nature);
      expect(parsed.toJson()).toEqual({
        name,
        direction,
        nature,
      });
    },
  );

  it('normaliza NFKC+trim antes de validar longitud', () => {
    const json = readFinancialFixture(
      'categoria_financiera/payload-renta-nfkc-valid.json',
    );
    const rawName = json.name as string;
    const parsed = CategoriaFinancieraCreadaPayload.fromJson(json);

    expect(parsed.name).toBe(rawName.normalize('NFKC').trim());
    expect([...parsed.name].some((c) => /[\u0300-\u036f]/.test(c))).toBe(false);
  });

  it.each([
    [
      'payload-nombre-101-invalid.json',
      'name debe tener entre 1 y 100 caracteres.',
    ],
    [
      'payload-nombre-vacio-invalid.json',
      'El nombre de la categoría financiera es obligatorio.',
    ],
    [
      'payload-nombre-no-string-invalid.json',
      'El nombre de la categoría financiera es obligatorio.',
    ],
    ['payload-direction-invalid.json', 'direction debe ser in u out.'],
    ['payload-direction-ausente-invalid.json', 'direction debe ser in u out.'],
    ['payload-nature-invalid.json', 'nature no está permitida.'],
    [
      'payload-nature-incompatible-invalid.json',
      'nature no es compatible con la dirección.',
    ],
  ] as const)('%s se rechaza con error canónico', (file, expected) => {
    expect(() =>
      CategoriaFinancieraCreadaPayload.fromJson(
        readFinancialFixture(`categoria_financiera/${file}`),
      ),
    ).toThrow(expected);
  });

  it('rechaza sobres con aggregate_type ajeno (pares del contrato §6.1)', () => {
    const sobre = readFinancialFixture(
      'categoria_financiera/sobre-aggregate-type-invalid.json',
    );
    const payload = sobre.payload as Record<string, unknown>;

    expect(() =>
      CategoriaFinancieraCreadaPayload.fromJson(payload),
    ).not.toThrow();
    expect(sobre.aggregate_type).not.toBe(
      CategoriaFinancieraCreadaPayload.aggregateType,
    );
  });
});
