import { readVariantTrackingFixture } from '../../testing/variant-tracking-fixtures';
import {
  RecursoInventarioCreadoPayload,
  readOriginVariantId,
} from './recurso-inventario-creado.payload';

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

/**
 * Procedencia. La clave la comparten el repo de análisis y Flutter; estos tests
 * leen los mismos archivos que Dart para que una revisión del contrato no pueda
 * quedar válida en un lado y rota en el otro.
 */
describe('RecursoInventarioCreadoPayload · origin_variant_id', () => {
  it('lee y reemite la procedencia del recurso autogenerado', () => {
    const payload = fixturePayload('alta/alta-autogenerada-origen-valido.json');
    const parsed = RecursoInventarioCreadoPayload.fromJson(payload);

    expect(parsed.originVariantId).toBe('a2000000-0000-4000-8000-000000000001');
    const json = parsed.toJson();
    const item = json.inventory_item as Record<string, unknown>;
    expect(item[RecursoInventarioCreadoPayload.originVariantIdField]).toBe(
      'a2000000-0000-4000-8000-000000000001',
    );
    // El resto de la forma canónica no cambia por añadir procedencia.
    expect(json.initial_movement).toBeNull();
    expect(Object.keys(item).sort()).toEqual([
      'default_unit_id',
      'inventory_item_id',
      'name',
      RecursoInventarioCreadoPayload.originVariantIdField,
    ]);
  });

  it('omite la clave en recursos independientes', () => {
    const parsed = RecursoInventarioCreadoPayload.fromJson(
      fixturePayload('alta/alta-independiente.json'),
    );

    expect(parsed.originVariantId).toBeNull();
    const item = parsed.toJson().inventory_item as Record<string, unknown>;
    expect(RecursoInventarioCreadoPayload.originVariantIdField in item).toBe(
      false,
    );
  });

  it('lee como desconocido el alta legada sin procedencia', () => {
    const parsed = RecursoInventarioCreadoPayload.fromJson(
      fixturePayload('alta/alta-legada-sin-origen.json'),
    );

    // El movimiento legado sigue siendo válido: la ausencia de origen no
    // invalida el resto del evento.
    expect(parsed.originVariantId).toBeNull();
    expect(parsed.initialMovement?.quantityDeltaAtomic).toBe(500);
  });

  it('acepta el sobre del alta autogenerada con la misma procedencia', () => {
    const parsed = RecursoInventarioCreadoPayload.fromJson(
      fixturePayload('alta/sobre-alta-valido.json'),
    );

    expect(parsed.originVariantId).toBe('a2000000-0000-4000-8000-000000000001');
  });

  it.each([
    [
      'alta/alta-autogenerada-origen-no-string.json',
      /debe ser un UUID v4 o null/,
    ],
    ['alta/alta-autogenerada-origen-no-uuid.json', /UUID v4/],
  ])('rechaza procedencia inválida en %s', (fixture, matcher) => {
    expect(() =>
      RecursoInventarioCreadoPayload.fromJson(fixturePayload(fixture)),
    ).toThrow(matcher);
  });

  it('rechaza el alta legada con UUID no v4 sin degradarla a null', () => {
    expect(() =>
      RecursoInventarioCreadoPayload.fromJson(
        fixturePayload('alta/alta-legada-uuid-incorrecto.json'),
      ),
    ).toThrow(/UUID v4/);
  });

  it('no declara referencias de entrega en el servidor', () => {
    // El origen es una identidad, no una LocalEventRef: el push no transporta
    // refs y el servidor no debe empezar a declararlas para el alta.
    const parsed = RecursoInventarioCreadoPayload.fromJson(
      fixturePayload('alta/alta-autogenerada-origen-valido.json'),
    );
    expect((parsed as unknown as { refs?: unknown }).refs).toBeUndefined();
  });
});

describe('readOriginVariantId', () => {
  it('trata ausencia y null como desconocido', () => {
    expect(readOriginVariantId({})).toBeNull();
    expect(
      readOriginVariantId({
        [RecursoInventarioCreadoPayload.originVariantIdField]: null,
      }),
    ).toBeNull();
  });
});

/** Devuelve solo el `payload` del sobre, que es lo que consume el contrato. */
function fixturePayload(relativePath: string): Record<string, unknown> {
  return readVariantTrackingFixture(relativePath).payload as Record<
    string,
    unknown
  >;
}

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
