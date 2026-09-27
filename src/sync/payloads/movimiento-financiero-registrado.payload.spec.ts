import { MovimientoFinancieroRegistradoPayload } from './movimiento-financiero-registrado.payload';
import { readFinancialFixture } from '../../testing/financial-fixtures';

const MAX_AMOUNT = 9007199254740991;

describe('MovimientoFinancieroRegistradoPayload (fixtures del contrato)', () => {
  it('parsea un registro cash canónico', () => {
    const parsed = MovimientoFinancieroRegistradoPayload.fromJson(
      readFinancialFixture('registro/entry-renta-cash-valid.json'),
    );

    expect(parsed.categoryId).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed.categoryEventId).toBe('22222222-2222-4222-8222-222222222222');
    expect(parsed.categoryNameSnapshot).toBe('Renta');
    expect(parsed.direction).toBe('out');
    expect(parsed.nature).toBe('operating');
    expect(parsed.amountMinor).toBe(50000);
    expect(parsed.method).toBe('cash');
    expect(parsed.occurredAtMs).toBe(1789041600000);
    expect(parsed.notes).toBe('Renta en efectivo');
    expect(parsed.reference).toBeNull();
    expect(parsed.toJson()).toEqual(
      readFinancialFixture('registro/entry-renta-cash-valid.json'),
    );
  });

  it('parsea transfer con referencia y registro de ingreso', () => {
    const transfer = MovimientoFinancieroRegistradoPayload.fromJson(
      readFinancialFixture('registro/entry-renta-transfer-valid.json'),
    );
    expect(transfer.method).toBe('transfer');
    expect(transfer.amountMinor).toBe(150000);
    expect(transfer.reference).toBe('SPEI-2026-09-20');
    expect(transfer.toJson()).toEqual(
      readFinancialFixture('registro/entry-renta-transfer-valid.json'),
    );

    const ingreso = MovimientoFinancieroRegistradoPayload.fromJson(
      readFinancialFixture('registro/entry-ingreso-cash-valid.json'),
    );
    expect(ingreso.direction).toBe('in');
    expect(ingreso.categoryId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(ingreso.categoryEventId).toBe(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    expect(ingreso.amountMinor).toBe(200000);
  });

  it('normaliza notas/referencia vacías o de solo espacios a null', () => {
    const [nulas, vacias, espacios] = [
      'entry-null-notes-reference-valid.json',
      'entry-referencia-vacia-valid.json',
      'entry-referencia-espacios-valid.json',
    ].map((file) =>
      MovimientoFinancieroRegistradoPayload.fromJson(
        readFinancialFixture(`registro/${file}`),
      ),
    );

    expect(nulas.notes).toBeNull();
    expect(nulas.reference).toBeNull();
    expect(vacias.notes).toBeNull();
    expect(vacias.reference).toBeNull();
    expect(espacios.notes).toBe('Renta en efectivo');
    expect(espacios.reference).toBeNull();
  });

  it('acepta 500 code points en notas y el mayor importe seguro', () => {
    const notas = MovimientoFinancieroRegistradoPayload.fromJson(
      readFinancialFixture('registro/entry-notas-500-valid.json'),
    );
    expect([...notas.notes!]).toHaveLength(500);

    const maximo = MovimientoFinancieroRegistradoPayload.fromJson(
      readFinancialFixture('registro/entry-monto-maximo-valid.json'),
    );
    expect(maximo.amountMinor).toBe(MAX_AMOUNT);
  });

  it.each([
    [
      'entry-notas-501-invalid.json',
      'notes debe tener entre 1 y 500 caracteres.',
    ],
    [
      'entry-monto-cero-invalid.json',
      'amount_minor debe ser un entero positivo en centavos.',
    ],
    [
      'entry-monto-negativo-invalid.json',
      'amount_minor debe ser un entero positivo en centavos.',
    ],
    [
      'entry-monto-fraccionario-invalid.json',
      'amount_minor debe ser un entero positivo en centavos.',
    ],
    [
      'entry-monto-superior-invalid.json',
      'amount_minor debe ser un entero positivo en centavos.',
    ],
    ['entry-moneda-invalid.json', 'Moneda inválida.'],
    ['entry-metodo-invalid.json', 'method debe ser cash o transfer.'],
    [
      'entry-occurred-cero-invalid.json',
      'occurred_at_ms debe ser un instante válido.',
    ],
    ['entry-category-id-invalid.json', 'category_id debe ser un UUID v4.'],
  ] as const)('%s se rechaza con error canónico', (file, expected) => {
    expect(() =>
      MovimientoFinancieroRegistradoPayload.fromJson(
        readFinancialFixture(`registro/${file}`),
      ),
    ).toThrow(expected);
  });

  it('acepta dirección/naturaleza que solo difieren de la categoría (decisiones del handler)', () => {
    for (const file of [
      'registro/entry-direction-snapshot-invalid.json',
      'registro/entry-nature-snapshot-invalid.json',
      'registro/entry-dependencia-inexistente.json',
    ]) {
      expect(() =>
        MovimientoFinancieroRegistradoPayload.fromJson(
          readFinancialFixture(file),
        ),
      ).not.toThrow();
    }
  });
});
