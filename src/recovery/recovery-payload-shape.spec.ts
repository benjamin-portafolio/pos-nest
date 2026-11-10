import { assertRecoveryPayloadShape } from './recovery-payload-shape';

describe('Recovery preserves admitted legacy evidence', () => {
  test('allows defaults and documented explicit nulls without rewriting original JSON', () => {
    expect(() =>
      assertRecoveryPayloadShape(
        { inventory_item: { origin_variant_id: null } },
        { inventory_item: {}, initial_movement: null },
        ['inventory_item.origin_variant_id'],
      ),
    ).not.toThrow();
    expect(() =>
      assertRecoveryPayloadShape({ cash: null }, {}, ['cash']),
    ).not.toThrow();
  });
  test('unknown null fields and fields nested in arrays remain rejected', () => {
    expect(() => assertRecoveryPayloadShape({ token: null }, {})).toThrow();
    expect(() => assertRecoveryPayloadShape({ cash: null }, {})).toThrow();
    expect(() =>
      assertRecoveryPayloadShape({ rows: [{ secret: null }] }, { rows: [{}] }),
    ).toThrow();
    expect(() =>
      assertRecoveryPayloadShape({ rows: [{}] }, { rows: [] }),
    ).toThrow();
  });
});
