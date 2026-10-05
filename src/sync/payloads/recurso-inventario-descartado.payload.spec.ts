import { readVariantTrackingFixture } from '../../testing/variant-tracking-fixtures';
import { RecursoInventarioDescartadoPayload } from './recurso-inventario-descartado.payload';

/**
 * Descarte de recurso autogenerado (contrato rev. 1 §6.3). El evento solo
 * existe en `standalone`: se emite con `delivery_status = not_required` y el
 * servidor lo rechaza funcionalmente sin borrar nada. Estos tests fijan la
 * forma del contrato y sus invariantes, no el efecto sobre la base de datos.
 */
describe('RecursoInventarioDescartadoPayload', () => {
  it('declara el agregado y la política admitida', () => {
    expect(RecursoInventarioDescartadoPayload.aggregateType).toBe(
      'inventory_item',
    );
    expect(RecursoInventarioDescartadoPayload.eventType).toBe(
      'recurso_inventario_descartado',
    );
    expect(RecursoInventarioDescartadoPayload.supportedPolicyVersion).toBe(1);
    // Invariante de modo: el descarte nunca viaja al servidor.
    expect(RecursoInventarioDescartadoPayload.deliveryStatus).toBe(
      'not_required',
    );
  });

  it('lee y reemite el descarte válido', () => {
    const payload = fixturePayload('descarte/descarte-valido.json');
    const parsed = RecursoInventarioDescartadoPayload.fromJson(payload);

    expect(parsed.baseEventId).toBe('b1000000-0000-4000-8000-000000000001');
    expect(parsed.triggerProductId).toBe(
      'a1000000-0000-4000-8000-000000000001',
    );
    expect(parsed.triggerProductEventId).toBe(
      'b3000000-0000-4000-8000-000000000003',
    );
    expect(parsed.originVariantId).toBe('a2000000-0000-4000-8000-000000000001');
    expect(parsed.policyVersion).toBe(1);
    expect(parsed.toJson()).toEqual(payload);
  });

  it('acepta el sobre completo sin declarar referencias de entrega', () => {
    const sobre = readVariantTrackingFixture(
      'descarte/sobre-descarte-valido.json',
    );
    expect(sobre.aggregate_type).toBe('inventory_item');
    expect(sobre.event_type).toBe('recurso_inventario_descartado');
    expect(
      RecursoInventarioDescartadoPayload.fromJson(
        sobre.payload as Record<string, unknown>,
      ).policyVersion,
    ).toBe(1);
  });

  it('no incluye inventory_item_id en el payload', () => {
    // El agregado ya es el recurso: incluir su id sería redundancia que puede
    // contradecir al sobre.
    expect(
      Object.keys(fixturePayload('descarte/descarte-valido.json')).sort(),
    ).toEqual([
      'base_event_id',
      'origin_variant_id',
      'policy_version',
      'trigger_product_event_id',
      'trigger_product_id',
    ]);
  });

  it('rechaza campos desconocidos', () => {
    expect(() =>
      RecursoInventarioDescartadoPayload.fromJson(
        fixturePayload('descarte/descarte-campo-desconocido.json'),
      ),
    ).toThrow(/campos no permitidos: force/);
  });

  it.each([
    ['descarte/descarte-policy-version-cero.json', 0],
    ['descarte/descarte-policy-version-invalida.json', 2],
  ])('rechaza policy_version distinta de 1 en %s', (fixture, version) => {
    expect(() =>
      RecursoInventarioDescartadoPayload.fromJson(fixturePayload(fixture)),
    ).toThrow(`policy_version solo admite 1`);
    expect(version).not.toBe(1);
  });

  it.each([
    'policy_version',
    'base_event_id',
    'trigger_product_id',
    'trigger_product_event_id',
    'origin_variant_id',
  ])('exige %s', (field) => {
    const payload = fixturePayload('descarte/descarte-valido.json');
    delete payload[field];
    expect(() =>
      RecursoInventarioDescartadoPayload.fromJson(payload),
    ).toThrow();
  });

  it('rechaza que el disparador sea el alta del recurso', () => {
    expect(() =>
      RecursoInventarioDescartadoPayload.fromJson(
        fixturePayload('descarte/descarte-trigger-igual-base.json'),
      ),
    ).toThrow(/no puede ser el alta del recurso/);
  });

  it('rechaza procedencia no v4', () => {
    expect(() =>
      RecursoInventarioDescartadoPayload.fromJson(
        fixturePayload('descarte/descarte-origen-no-uuid.json'),
      ),
    ).toThrow(/UUID v4/);
  });

  it('no declara referencias de entrega', () => {
    const parsed = RecursoInventarioDescartadoPayload.fromJson(
      fixturePayload('descarte/descarte-valido.json'),
    );
    expect((parsed as unknown as { refs?: unknown }).refs).toBeUndefined();
  });
});

function fixturePayload(relativePath: string): Record<string, unknown> {
  return readVariantTrackingFixture(relativePath).payload as Record<
    string,
    unknown
  >;
}
