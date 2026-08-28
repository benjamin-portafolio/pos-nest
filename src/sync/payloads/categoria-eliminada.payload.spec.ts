import { CategoriaEliminadaPayload } from './categoria-eliminada.payload';

describe('CategoriaEliminadaPayload', () => {
  it('parsea y produce el payload canónico', () => {
    const json = payload();
    const parsed = CategoriaEliminadaPayload.fromJson(json);

    expect(parsed.baseEventId).toBe('event-base');
    expect(parsed.deletedCategory.name).toBe('Test');
    expect(parsed.toJson()).toEqual(json);
  });

  it('parsea move y uncategorize con productos canónicos', () => {
    const move = {
      ...payload(),
      product_resolution: {
        type: 'move',
        destination_category: {
          category_id: 'destination',
          base_event_id: 'destination-base',
          base_version: 4,
          base_server_sequence: 30,
        },
      },
      linked_products: [linkedProduct('product-1', 'destination')],
    };
    const parsedMove = CategoriaEliminadaPayload.fromJson(move);
    expect(parsedMove.productResolution.type).toBe('move');
    expect(parsedMove.toJson()).toEqual(move);
    expect(() => parsedMove.validateForSourceCategory('source')).not.toThrow();

    const uncategorize = {
      ...payload(),
      product_resolution: { type: 'uncategorize' },
      linked_products: [linkedProduct('product-1', null)],
    };
    expect(CategoriaEliminadaPayload.fromJson(uncategorize).toJson()).toEqual(
      uncategorize,
    );
  });

  it('rechaza delete, productos inválidos y orden inválido', () => {
    expect(() =>
      CategoriaEliminadaPayload.fromJson({
        ...payload(),
        product_resolution: { type: 'delete' },
      }),
    ).toThrow(/none, move o uncategorize/);
    expect(() =>
      CategoriaEliminadaPayload.fromJson({
        ...payload(),
        linked_products: ['product-1'],
      }),
    ).toThrow(/objeto/);
    expect(() =>
      CategoriaEliminadaPayload.fromJson({
        ...payload(),
        shifted_categories: [
          {
            ...(
              payload().shifted_categories as Array<Record<string, unknown>>
            )[0],
            sort_order: { from: 1, to: 2 },
          },
        ],
      }),
    ).toThrow(/to = from - 1/);
  });

  it('rechaza duplicados, bases inválidas y destino incompatible', () => {
    expect(() =>
      CategoriaEliminadaPayload.fromJson({
        ...payload(),
        product_resolution: { type: 'uncategorize' },
        linked_products: [
          linkedProduct('product-1', null),
          linkedProduct('product-1', null),
        ],
      }),
    ).toThrow(/ordenado/);
    expect(() =>
      CategoriaEliminadaPayload.fromJson({
        ...payload(),
        product_resolution: { type: 'uncategorize' },
        linked_products: [
          { ...linkedProduct('product-1', null), base_version: 0 },
        ],
      }),
    ).toThrow(/entero >= 1/);
    expect(() =>
      CategoriaEliminadaPayload.fromJson({
        ...payload(),
        product_resolution: { type: 'move' },
      }),
    ).toThrow(/destination_category/);
    expect(() =>
      CategoriaEliminadaPayload.fromJson({
        ...payload(),
        product_resolution: {
          type: 'uncategorize',
          destination_category: null,
        },
      }),
    ).toThrow(/no admite/);
  });

  it('ignora campos adicionales conocidos por versiones futuras', () => {
    expect(
      CategoriaEliminadaPayload.fromJson({
        ...payload(),
        future: true,
      }).toJson(),
    ).not.toHaveProperty('future');
  });
});

function payload(): Record<string, unknown> {
  return {
    base_event_id: 'event-base',
    deleted_category: {
      name: 'Test',
      color_key: 'amber',
      sort_order: 0,
      active: true,
      created_event_id: 'event-created',
    },
    product_resolution: { type: 'none' },
    linked_products: [],
    shifted_categories: [
      {
        category_id: 'category-after',
        base_event_id: 'event-after-base',
        base_version: 3,
        base_server_sequence: 21,
        sort_order: { from: 1, to: 0 },
      },
    ],
  };
}

function linkedProduct(
  productId: string,
  destinationId: string | null,
): Record<string, unknown> {
  return {
    product_id: productId,
    base_event_id: `${productId}-base`,
    base_version: 2,
    base_server_sequence: 25,
    category_id: { from: 'source', to: destinationId },
  };
}
