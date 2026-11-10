import { EntityManager } from 'typeorm';
import {
  ProductoCreadoPayload,
  ProductoCreadoVariantValue,
} from '../sync/payloads/producto-creado.payload';
import { ProductoActualizadoPayload } from '../sync/payloads/producto-actualizado.payload';
import {
  CategoriaEventContract,
  CATEGORIA_CREADA,
  CATEGORIA_ACTUALIZADA,
  CATEGORIA_MOVIDA,
} from '../sync/payloads/categoria-event-contract';
import { CategoriaEliminadaPayload } from '../sync/payloads/categoria-eliminada.payload';
import {
  recoveryAssert as check,
  recoveryCompare as compare,
  recoveryEvent as event,
  recoveryHistory as history,
  recoveryMetadata as metadata,
} from './recovery-business-validation';
import { canonical } from './recovery-contract';

export async function validateRecoveryCatalog(m: EntityManager) {
  for (const [aggregate, creation] of [
    ['category', 'categoria_creada'],
    ['product', 'producto_creado'],
  ]) {
    const [orphan] = await m.query(
      `SELECT e.event_id FROM events e WHERE e.sync_status='synced' AND e.aggregate_type=$1 AND NOT EXISTS(SELECT 1 FROM events c WHERE c.aggregate_type=$1 AND c.aggregate_id=e.aggregate_id AND c.event_type=$2 AND c.sync_status='synced' AND c.server_sequence<=e.server_sequence) LIMIT 1`,
      [aggregate, creation],
    );
    check(!orphan, aggregate, orphan?.event_id, 'creator_missing');
  }
  // Validate read-only semantic states. Materialization remains a direct copy
  // of the supplied baseline; this never calls handlers or emits business facts.
  for await (const creator of history(m, "event_type='categoria_creada'", [])) {
    const id = creator.aggregate_id;
    let state: any = null,
      version = 0,
      last: any;
    for await (const e of history(
      m,
      `aggregate_type='category' AND (aggregate_id=$1 OR payload->'displaced_category'->>'category_id'=$1::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(payload->'shifted_categories','[]'::jsonb)) x WHERE x->>'category_id'=$1::text))`,
      [id],
    )) {
      if (e.event_type === CATEGORIA_CREADA) {
        check(!state && !last, 'categories', id, 'duplicate_creator');
        const p = CategoriaEventContract.parseCategoriaCreadaPayload(e.payload);
        check(!('error' in p), 'categories', id, 'invalid_creation');
        check(
          e.base_version === 1 && e.base_server_sequence === null,
          'categories',
          id,
          'initial_version',
        );
        state = {
          name: p.name,
          color_key: p.colorKey,
          sort_order: p.sortOrder,
        };
        version = 1;
      } else {
        check(state, 'categories', id, 'missing_or_deleted');
        if (e.event_type === CATEGORIA_ACTUALIZADA) {
          const p = CategoriaEventContract.parseCategoriaActualizadaPayload(
            e.payload,
          );
          check(!('error' in p), 'categories', id, 'invalid_update');
          await categoryDependency(m, p.baseEventId, id, e);
          check(
            e.base_version === null ||
              (e.base_version >= 1 && e.base_version <= version),
            'categories',
            id,
            'base_version',
          );
          if (p.name) {
            check(state.name === p.name.from, 'categories', id, 'name_before');
            state.name = p.name.to;
          }
          if (p.colorKey) {
            check(
              state.color_key === p.colorKey.from,
              'categories',
              id,
              'color_before',
            );
            state.color_key = p.colorKey.to;
          }
        } else if (e.event_type === CATEGORIA_MOVIDA) {
          const p = CategoriaEventContract.parseCategoriaMovidaPayload(
            e.payload,
          );
          check(!('error' in p), 'categories', id, 'invalid_move');
          const own = e.aggregate_id === id;
          await categoryDependency(
            m,
            own ? p.baseEventId : p.displacedBaseEventId,
            id,
            e,
          );
          check(
            state.sort_order === (own ? p.fromOrder : p.displacedFromOrder),
            'categories',
            id,
            'order_before',
          );
          state.sort_order = own ? p.toOrder : p.displacedToOrder;
        } else if (e.event_type === CategoriaEliminadaPayload.eventType) {
          const p = CategoriaEliminadaPayload.fromJson(e.payload);
          p.validateForSourceCategory(e.aggregate_id);
          if (e.aggregate_id === id) {
            check(
              p.baseEventId === last.event_id &&
                e.base_version === version &&
                (e.base_server_sequence === null ||
                  String(e.base_server_sequence) ===
                    String(last.server_sequence)),
              'categories',
              id,
              'delete_base',
            );
            compare(
              { ...state, active: true, created_event_id: creator.event_id },
              {
                name: p.deletedCategory.name,
                color_key: p.deletedCategory.colorKey,
                sort_order: p.deletedCategory.sortOrder,
                active: p.deletedCategory.active,
                created_event_id: p.deletedCategory.createdEventId,
              },
              'categories',
              id,
            );
            state = null;
          } else {
            const shifted = p.shiftedCategories.find(
              (x) => x.categoryId === id,
            );
            check(shifted, 'categories', id, 'shift_missing');
            check(
              shifted.baseEventId === last.event_id &&
                shifted.baseVersion === version &&
                (shifted.baseServerSequence === null ||
                  String(shifted.baseServerSequence) ===
                    String(last.server_sequence)) &&
                state.sort_order === shifted.fromOrder,
              'categories',
              id,
              'shift_base',
            );
            state.sort_order = shifted.toOrder;
          }
        } else check(false, 'categories', id, 'unknown_transition');
        version++;
      }
      last = e;
    }
    const [row] = await m.query(
      'SELECT * FROM categories WHERE category_id=$1',
      [id],
    );
    if (state)
      compare(
        row,
        { ...metadata(last, version, creator.event_id), ...state },
        'categories',
        id,
      );
    else check(!row, 'categories', id, 'deleted_category_present');
  }
  const [orphanCategory] = await m.query(
    "SELECT c.category_id FROM categories c LEFT JOIN events e ON e.event_id=c.created_event_id WHERE e.event_type IS DISTINCT FROM 'categoria_creada' OR e.aggregate_id<>c.category_id OR e.sync_status IS DISTINCT FROM 'synced' LIMIT 1",
  );
  check(
    !orphanCategory,
    'categories',
    orphanCategory?.category_id,
    'creator_missing',
  );
  for await (const e of history(m, "event_type='espacio_creado'", [])) {
    const [row] = await m.query('SELECT * FROM espacios WHERE espacio_id=$1', [
      e.aggregate_id,
    ]);
    check(
      e.base_version === 1 && e.base_server_sequence === null,
      'espacios',
      e.aggregate_id,
      'initial_version',
    );
    compare(
      row,
      {
        ...metadata(e),
        nombre: e.payload.nombre,
        identificacion: e.payload.identificacion,
        visibilidad:
          e.payload.visibilidad === 'sin_restriccion'
            ? 0
            : e.payload.visibilidad === 'solo_restringido'
              ? 1
              : e.payload.visibilidad,
      },
      'espacios',
      e.aggregate_id,
    );
  }
  const [orphanSpace] = await m.query(
    "SELECT p.espacio_id FROM espacios p LEFT JOIN events e ON e.event_id=p.created_event_id WHERE e.event_type IS DISTINCT FROM 'espacio_creado' OR e.aggregate_id<>p.espacio_id OR e.sync_status IS DISTINCT FROM 'synced' LIMIT 1",
  );
  check(!orphanSpace, 'espacios', orphanSpace?.espacio_id, 'creator_missing');
  for await (const creator of history(m, "event_type='producto_creado'", [])) {
    const id = creator.aggregate_id;
    let current: ProductoCreadoPayload | null = null,
      active = true,
      version = 0,
      last: any;
    for await (const e of history(
      m,
      `(aggregate_type='product' AND aggregate_id=$1) OR (event_type='categoria_eliminada' AND EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'linked_products') x WHERE x->>'product_id'=$1::text))`,
      [id],
    )) {
      if (e.event_type === ProductoCreadoPayload.eventType) {
        check(!current, 'products', id, 'duplicate_creator');
        current = ProductoCreadoPayload.fromJson(e.payload);
        check(
          e.base_version === 1 && e.base_server_sequence === null,
          'products',
          id,
          'initial_version',
        );
        version = 1;
      } else if (e.event_type === ProductoActualizadoPayload.eventType) {
        const p = ProductoActualizadoPayload.fromJson(e.payload);
        check(
          current &&
            active &&
            p.baseEventId === last.event_id &&
            e.base_version === version &&
            ProductoActualizadoPayload.sameEditingBase(current, p.before),
          'products',
          id,
          'editing_base',
        );
        if (e.base_server_sequence !== null)
          check(
            String(e.base_server_sequence) === String(last.server_sequence),
            'products',
            id,
            'base_sequence',
          );
        current = p.after;
        active = !p.deleteProduct;
        version++;
      } else if (e.event_type === CategoriaEliminadaPayload.eventType) {
        const p = CategoriaEliminadaPayload.fromJson(e.payload),
          linked = p.linkedProducts.find((x) => x.productId === id);
        check(
          current &&
            linked &&
            linked.baseEventId === last.event_id &&
            linked.baseVersion === version &&
            (linked.baseServerSequence === null ||
              String(linked.baseServerSequence) ===
                String(last.server_sequence)) &&
            current.categoryId === linked.fromCategoryId,
          'products',
          id,
          'category_delete_base',
        );
        current = new ProductoCreadoPayload(
          current.name,
          linked.toCategoryId,
          current.saleConfiguration,
          current.variants,
          null,
          current.inventoryDependencies,
          current.supplierDependencies,
        );
        version++;
      }
      check(current, 'products', id, 'missing_state');
      if (e.aggregate_type === 'product') {
        await productDependencies(m, current, e);
        // A future tombstone may retain each identity, but no declared variant
        // may disappear from the snapshot because its chunk was omitted.
        const p =
          e.event_type === ProductoActualizadoPayload.eventType
            ? ProductoActualizadoPayload.fromJson(e.payload)
            : null;
        for (const v of [...current.variants, ...(p?.removedVariants ?? [])]) {
          const [row] = await m.query(
            'SELECT product_id FROM product_variants WHERE variant_id=$1',
            [v.id],
          );
          check(
            row?.product_id === id,
            'product_variants',
            v.id,
            'missing_projection',
          );
        }
      }
      last = e;
    }
    check(current, 'products', id, 'missing_state');
    const [row] = await m.query('SELECT * FROM products WHERE product_id=$1', [
      id,
    ]);
    compare(
      row,
      {
        ...metadata(last, version, creator.event_id, active),
        name: current.name,
        category_id: current.categoryId,
        sale_mode: current.saleConfiguration.mode,
        sale_unit_id:
          current.saleConfiguration.mode === 'measured'
            ? current.saleConfiguration.saleUnitId
            : null,
        price_reference_quantity_atomic:
          current.saleConfiguration.mode === 'measured'
            ? String(current.saleConfiguration.priceReferenceQuantityAtomic)
            : null,
      },
      'products',
      id,
    );
  }
  const [orphanProduct] = await m.query(
    "SELECT p.product_id FROM products p LEFT JOIN events e ON e.event_id=p.created_event_id WHERE e.event_type IS DISTINCT FROM 'producto_creado' OR e.aggregate_id<>p.product_id OR e.sync_status IS DISTINCT FROM 'synced' LIMIT 1",
  );
  check(
    !orphanProduct,
    'products',
    orphanProduct?.product_id,
    'creator_missing',
  );
  let after = '';
  for (;;) {
    const rows = await m.query(
      'SELECT * FROM product_variants WHERE variant_id::text>$1 ORDER BY variant_id LIMIT 200',
      [after],
    );
    if (!rows.length) break;
    for (const row of rows) {
      after = row.variant_id;
      let value: ProductoCreadoVariantValue | undefined,
        active = true,
        last: any,
        creator: any,
        version = 1,
        remembered: string | null = null,
        memoryEvent: any;
      for await (const e of history(
        m,
        "aggregate_type='product' AND aggregate_id=$1",
        [row.product_id],
      )) {
        const update =
          e.event_type === ProductoActualizadoPayload.eventType
            ? ProductoActualizadoPayload.fromJson(e.payload)
            : null;
        const state =
          update?.after ?? ProductoCreadoPayload.fromJson(e.payload);
        const next = state.variants.find((v) => v.id === row.variant_id);
        if (update?.deleteProduct) {
          if (value) {
            active = false;
            last = e;
            version = e.base_version + 1;
          }
          continue;
        }
        if (next) {
          check(active, 'product_variants', after, 'reactivated_tombstone');
          value = next;
          creator ??= e;
          last = e;
          version =
            e.event_type === ProductoCreadoPayload.eventType
              ? 1
              : e.base_version + 1;
          if (next.inventoryItemId && next.inventoryItemId !== remembered) {
            remembered = next.inventoryItemId;
            memoryEvent = e;
          }
        } else if (update?.removedVariants.some((v) => v.id === after)) {
          active = false;
          last = e;
          version = e.base_version + 1;
        }
      }
      check(
        value && last && creator,
        'product_variants',
        after,
        'variant_evidence',
      );
      compare(
        row,
        {
          ...metadata(last, version, creator.event_id, active),
          name: value.name,
          name_key: value.nameKey,
          barcode: value.barcode,
          sale_price_minor: String(value.salePriceMinor),
          offer_price_minor:
            value.offerPriceMinor == null
              ? null
              : String(value.offerPriceMinor),
          standard_cost_minor:
            value.standardCostMinor == null
              ? null
              : String(value.standardCostMinor),
          minimum_stock_atomic:
            value.minimumStockAtomic == null
              ? null
              : String(value.minimumStockAtomic),
          inventory_item_id: value.inventoryItemId,
          sort_order: value.sortOrder,
        },
        'product_variants',
        after,
      );
      const recipes = await m.query(
        'SELECT inventory_item_id,quantity_atomic FROM recipe_components WHERE variant_id=$1 ORDER BY inventory_item_id',
        [after],
      );
      check(
        canonical(recipes) ===
          canonical(
            value.recipeComponents
              .map((c) => ({
                inventory_item_id: c.inventoryItemId,
                quantity_atomic: String(c.quantityAtomic),
              }))
              .sort((a, b) =>
                a.inventory_item_id.localeCompare(b.inventory_item_id),
              ),
          ),
        'recipe_components',
        after,
        'exact_set',
      );
      {
        const suppliers = await m.query(
          'SELECT supplier_id,quoted_price_minor,quoted_at_ms FROM variant_suppliers WHERE variant_id=$1 ORDER BY supplier_id',
          [after],
        );
        check(
          canonical(suppliers) ===
            canonical(
              (value.suppliers ?? []).map((s) => ({
                supplier_id: s.supplierId,
                quoted_price_minor: String(s.quotedPriceMinor),
                quoted_at_ms: String(s.quotedAtMs),
              })),
            ),
          'variant_suppliers',
          after,
          'exact_set',
        );
      }
      const [memory] = await m.query(
        'SELECT * FROM variant_inventory_memory WHERE variant_id=$1',
        [after],
      );
      if (remembered)
        compare(
          memory,
          {
            inventory_item_id: remembered,
            source_event_id: memoryEvent.event_id,
            source_server_sequence: String(memoryEvent.server_sequence),
          },
          'variant_inventory_memory',
          after,
        );
      else
        check(!memory, 'variant_inventory_memory', after, 'unexplained_memory');
    }
  }
}
async function categoryDependency(
  m: EntityManager,
  id: string,
  categoryId: string,
  e: any,
) {
  const d = await event(m, id, e);
  check(
    d.aggregate_type === 'category' &&
      (d.aggregate_id === categoryId ||
        d.payload.displaced_category?.category_id === categoryId ||
        d.payload.shifted_categories?.some(
          (x: any) => x.category_id === categoryId,
        )),
    'categories',
    categoryId,
    'dependency_identity',
  );
}
async function productDependencies(
  m: EntityManager,
  p: ProductoCreadoPayload,
  e: any,
) {
  for (const id of p.dependencyEventIds) await event(m, id, e);
  if (p.categoryId) {
    const [creation] = await m.query(
      "SELECT event_id FROM events WHERE aggregate_type='category' AND aggregate_id=$1 AND event_type='categoria_creada' AND sync_status='synced' AND server_sequence<$2 LIMIT 1",
      [p.categoryId, e.server_sequence],
    );
    check(creation, 'products', e.aggregate_id, 'category_creator_missing');
  }
  for (const d of p.inventoryDependencies) {
    const [item] = await m.query(
      'SELECT created_event_id FROM inventory_items WHERE inventory_item_id=$1',
      [d.refId],
    );
    check(item, 'products', e.aggregate_id, 'inventory_missing');
    await event(m, item.created_event_id, e);
  }
  for (const d of p.supplierDependencies) {
    const [supplier] = await m.query(
      'SELECT supplier_id FROM suppliers WHERE supplier_id=$1',
      [d.refId],
    );
    check(supplier, 'products', e.aggregate_id, 'supplier_missing');
  }
}
