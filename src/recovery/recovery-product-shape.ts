/** Closed keys of the product contract, including documented legacy fields
 * intentionally omitted by toJson(). Called only AFTER the typed parser. */
export function assertRecoveryProductShape(
  payload: any,
  updated = false,
): void {
  const keys = (value: any, allowed: string[]) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !allowed.includes(k))
    )
      throw new Error('Unknown product payload field');
  };
  const state = (p: any) => {
    keys(p, ['product', 'variants', 'dependencies']);
    keys(p.product, ['name', 'category_id', 'sale_configuration']);
    keys(p.product.sale_configuration, [
      'mode',
      'sale_unit_id',
      'price_reference_quantity_atomic',
    ]);
    for (const v of p.variants) {
      keys(v, [
        'variant_id',
        'name',
        'sku',
        'is_default',
        'barcode',
        'sale_price_minor',
        'offer_price_minor',
        'standard_cost_minor',
        'minimum_stock_atomic',
        'inventory_item_id',
        'inventory_configuration',
        'suppliers',
        'sort_order',
      ]);
      if ('is_default' in v && typeof v.is_default !== 'boolean')
        throw new Error('Invalid legacy default');
      if (v.inventory_configuration != null) {
        keys(v.inventory_configuration, ['enabled', 'components']);
        for (const c of v.inventory_configuration.components ?? [])
          keys(c, ['inventory_item_id', 'quantity_atomic']);
      }
      for (const s of v.suppliers ?? [])
        keys(s, ['supplier_id', 'quoted_price_minor', 'quoted_at_ms']);
    }
    for (const d of p.dependencies) {
      keys(
        d,
        d.ref_type === 'category'
          ? [
              'ref_type',
              'ref_id',
              'depends_on_event_id',
              'base_event_id',
              'base_version',
              'base_server_sequence',
            ]
          : d.ref_type === 'unit'
            ? ['ref_type', 'ref_id']
            : ['ref_type', 'ref_id', 'depends_on_event_id'],
      );
    }
  };
  if (updated) {
    keys(payload, ['base_event_id', 'before', 'after', 'delete_product']);
    state(payload.before);
    if (payload.after != null) state(payload.after);
  } else state(payload);
}
