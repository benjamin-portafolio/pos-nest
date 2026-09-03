import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ProductoCreadoPayload,
  normalizeVariantName,
  productVariantNameRefId,
} from './producto-creado.payload';

const _productId = '00000000-0000-4000-8000-000000000010';
const _variant1 = '00000000-0000-4000-8000-000000000001';
const _variant2 = '00000000-0000-4000-8000-000000000002';
const _inventoryItem = '00000000-0000-4000-8000-000000000020';
const _inventoryItem2 = '00000000-0000-4000-8000-000000000022';
const _inventoryEvent = '00000000-0000-4000-8000-000000000021';

describe('ProductoCreadoPayload', () => {
  it('parsea y serializa canónicamente una y varias variantes', () => {
    const simple = ProductoCreadoPayload.fromJson(productPayload());
    expect(simple.variants).toHaveLength(1);
    expect(simple.toJson()).toEqual(
      expect.objectContaining({
        variants: [
          expect.objectContaining({
            standard_cost_minor: null,
            is_default: true,
            sort_order: 0,
          }),
        ],
      }),
    );

    const advanced = ProductoCreadoPayload.fromJson(advancedProductPayload());
    expect(advanced.variants).toEqual([
      expect.objectContaining({
        name: 'Grande',
        nameKey: 'grande',
        salePriceMinor: 1000,
        standardCostMinor: 200,
        isDefault: true,
        sortOrder: 0,
      }),
      expect.objectContaining({
        name: null,
        nameKey: null,
        salePriceMinor: 1200,
        standardCostMinor: 0,
        isDefault: false,
        sortOrder: 1,
      }),
    ]);
  });

  it('acepta eventos históricos sin standard_cost_minor como null', () => {
    const payload = productPayload();
    delete (payload.variants as Array<Record<string, unknown>>)[0]
      .standard_cost_minor;

    const canonical = ProductoCreadoPayload.fromJson(payload).toJson();
    expect(
      (canonical.variants as Array<Record<string, unknown>>)[0]
        .standard_cost_minor,
    ).toBeNull();
  });

  it('vincula exactamente un recurso por variante y limpia la dependencia local', () => {
    const payload = productPayload();
    (payload.variants as Array<Record<string, unknown>>)[0].inventory_item_id =
      _inventoryItem;
    payload.dependencies = [
      {
        ref_type: 'inventory_item',
        ref_id: _inventoryItem,
        depends_on_event_id: _inventoryEvent,
      },
    ];

    const parsed = ProductoCreadoPayload.fromJson(payload);

    expect(parsed.variants[0].inventoryItemId).toBe(_inventoryItem);
    expect(parsed.toJson({ includeInventoryEventDependencies: false })).toEqual(
      expect.objectContaining({
        dependencies: [{ ref_type: 'inventory_item', ref_id: _inventoryItem }],
      }),
    );
  });

  it('rechaza vínculos sin dependencia y recursos repetidos', () => {
    const missingDependency = productPayload();
    (
      missingDependency.variants as Array<Record<string, unknown>>
    )[0].inventory_item_id = _inventoryItem;
    expect(() => ProductoCreadoPayload.fromJson(missingDependency)).toThrow(
      'deben coincidir',
    );

    const duplicate = advancedProductPayload();
    for (const variant of duplicate.variants as Array<
      Record<string, unknown>
    >) {
      variant.inventory_item_id = _inventoryItem;
    }
    duplicate.dependencies = [
      { ref_type: 'inventory_item', ref_id: _inventoryItem },
    ];
    expect(() => ProductoCreadoPayload.fromJson(duplicate)).toThrow(
      'no pueden repetirse',
    );
  });

  it('parsea y serializa canónicamente una receta por variante', () => {
    const parsed = ProductoCreadoPayload.fromJson(recipeProductPayload());

    expect(parsed.variants[0].inventoryItemId).toBeNull();
    expect(parsed.variants[0].recipeComponents).toEqual([
      { inventoryItemId: _inventoryItem, quantityAtomic: 250 },
      { inventoryItemId: _inventoryItem2, quantityAtomic: 2 },
    ]);
    expect(parsed.toJson()).toEqual(
      expect.objectContaining({
        variants: [
          expect.objectContaining({
            inventory_configuration: {
              enabled: true,
              components: [
                {
                  inventory_item_id: _inventoryItem,
                  quantity_atomic: 250,
                },
                {
                  inventory_item_id: _inventoryItem2,
                  quantity_atomic: 2,
                },
              ],
            },
          }),
        ],
      }),
    );
  });

  it('rechaza receta vacía, cantidades inválidas y componentes repetidos', () => {
    const empty = recipeProductPayload();
    const emptyConfiguration = (
      empty.variants as Array<Record<string, unknown>>
    )[0].inventory_configuration as Record<string, unknown>;
    emptyConfiguration.components = [];
    expect(() => ProductoCreadoPayload.fromJson(empty)).toThrow(
      'requiere componentes',
    );

    const invalidQuantity = recipeProductPayload();
    const invalidComponents = recipeComponents(invalidQuantity);
    invalidComponents[0].quantity_atomic = 0;
    expect(() => ProductoCreadoPayload.fromJson(invalidQuantity)).toThrow(
      'quantity_atomic',
    );

    const duplicate = recipeProductPayload();
    const duplicateComponents = recipeComponents(duplicate);
    duplicateComponents[1].inventory_item_id = _inventoryItem2;
    expect(() => ProductoCreadoPayload.fromJson(duplicate)).toThrow(
      'no puede repetirse',
    );
  });

  it('rechaza receta junto con vínculo directo o sin dependencias exactas', () => {
    const directAndRecipe = recipeProductPayload();
    (
      directAndRecipe.variants as Array<Record<string, unknown>>
    )[0].inventory_item_id = _inventoryItem;
    expect(() => ProductoCreadoPayload.fromJson(directAndRecipe)).toThrow(
      'simultáneamente',
    );

    const missingDependency = recipeProductPayload();
    missingDependency.dependencies = [
      { ref_type: 'inventory_item', ref_id: _inventoryItem },
    ];
    expect(() => ProductoCreadoPayload.fromJson(missingDependency)).toThrow(
      'componentes de receta',
    );
  });

  it('comparte vectores NFKC, trim, name_key y referencia con Dart', () => {
    const vectors = JSON.parse(
      readFileSync(
        join(process.cwd(), 'test/fixtures/product_variant_name_vectors.json'),
        'utf8',
      ),
    ) as Array<{
      input: string | null;
      name: string | null;
      name_key: string | null;
      ref_suffix: string | null;
    }>;

    for (const vector of vectors) {
      const normalized = normalizeVariantName(vector.input);
      expect(normalized).toEqual({
        name: vector.name,
        nameKey: vector.name_key,
      });
      expect(
        normalized.nameKey === null
          ? null
          : productVariantNameRefId(_productId, normalized.nameKey).split(
              ':',
            )[1],
      ).toBe(vector.ref_suffix);
    }
  });

  it('mide 160 puntos de código y rechaza 161', () => {
    expect(normalizeVariantName('😀'.repeat(160)).name).toHaveLength(320);
    expect(() => normalizeVariantName('😀'.repeat(161))).toThrow(
      '160 caracteres',
    );
  });

  it.each([null, 0, 1, Number.MAX_SAFE_INTEGER])(
    'acepta standard_cost_minor %s',
    (cost) => {
      const payload = productPayload();
      (
        payload.variants as Array<Record<string, unknown>>
      )[0].standard_cost_minor = cost;
      expect(
        ProductoCreadoPayload.fromJson(payload).variants[0].standardCostMinor,
      ).toBe(cost);
    },
  );

  it('rechaza costo negativo', () => {
    const payload = productPayload();
    (
      payload.variants as Array<Record<string, unknown>>
    )[0].standard_cost_minor = -1;
    expect(() => ProductoCreadoPayload.fromJson(payload)).toThrow(
      'standard_cost_minor',
    );
  });

  it.each([
    ['IDs repetidos', duplicateIdPayload()],
    ['orden con hueco', invalidOrderPayload()],
    ['dos predeterminadas', invalidDefaultPayload()],
    ['name_key repetido', duplicateNamePayload()],
  ])('rechaza %s', (_, payload) => {
    expect(() => ProductoCreadoPayload.fromJson(payload)).toThrow();
  });
});

function productPayload(): Record<string, unknown> {
  return {
    product: {
      name: 'Café',
      category_id: null,
      sale_configuration: { mode: 'unit' },
    },
    variants: [
      {
        variant_id: _variant1,
        name: null,
        sku: null,
        barcode: null,
        sale_price_minor: 1000,
        standard_cost_minor: null,
        is_default: true,
        sort_order: 0,
      },
    ],
    dependencies: [],
  };
}

function advancedProductPayload(): Record<string, unknown> {
  const payload = productPayload();
  payload.variants = [
    {
      variant_id: _variant1,
      name: '  Ｇｒａｎｄｅ  ',
      sku: null,
      barcode: null,
      sale_price_minor: 1000,
      standard_cost_minor: 200,
      is_default: true,
      sort_order: 0,
    },
    {
      variant_id: _variant2,
      name: '',
      sku: null,
      barcode: null,
      sale_price_minor: 1200,
      standard_cost_minor: 0,
      is_default: false,
      sort_order: 1,
    },
  ];
  return payload;
}

function recipeProductPayload(): Record<string, unknown> {
  const payload = productPayload();
  (
    payload.variants as Array<Record<string, unknown>>
  )[0].inventory_configuration = {
    enabled: true,
    components: [
      { inventory_item_id: _inventoryItem2, quantity_atomic: 2 },
      { inventory_item_id: _inventoryItem, quantity_atomic: 250 },
    ],
  };
  payload.dependencies = [
    { ref_type: 'inventory_item', ref_id: _inventoryItem2 },
    { ref_type: 'inventory_item', ref_id: _inventoryItem },
  ];
  return payload;
}

function recipeComponents(
  payload: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const variant = (payload.variants as Array<Record<string, unknown>>)[0];
  const configuration = variant.inventory_configuration as Record<
    string,
    unknown
  >;
  return configuration.components as Array<Record<string, unknown>>;
}

function duplicateIdPayload(): Record<string, unknown> {
  const payload = advancedProductPayload();
  (payload.variants as Array<Record<string, unknown>>)[1].variant_id =
    _variant1;
  return payload;
}

function invalidOrderPayload(): Record<string, unknown> {
  const payload = advancedProductPayload();
  (payload.variants as Array<Record<string, unknown>>)[1].sort_order = 2;
  return payload;
}

function invalidDefaultPayload(): Record<string, unknown> {
  const payload = advancedProductPayload();
  (payload.variants as Array<Record<string, unknown>>)[1].is_default = true;
  return payload;
}

function duplicateNamePayload(): Record<string, unknown> {
  const payload = advancedProductPayload();
  (payload.variants as Array<Record<string, unknown>>)[1].name = 'GRANDE';
  return payload;
}
