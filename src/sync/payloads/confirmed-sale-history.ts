import { EntityManager } from 'typeorm';
import { isDeepStrictEqual } from 'util';
import { EventEntity } from '../../entities/event.entity';
import { UnitEntity } from '../../entities/unit.entity';
import { EventSyncStatus } from '../../enums/event-sync-status.enum';
import { SaleMode } from '../../enums/sale-mode.enum';
import { ProductoCreadoPayload } from './producto-creado.payload';
import { ProductoActualizadoPayload } from './producto-actualizado.payload';
import { ConfirmedSaleLine } from './venta-confirmada.payload';
/** Read-only historical contracts shared by push and baseline validation. */
export class ConfirmedSaleHistory {
  static async validatePriceHistory(
    manager: EntityManager,
    l: ConfirmedSaleLine,
  ): Promise<string | null> {
    const s = l.snapshot;
    if (s.price_snapshot_version !== 2) return null;
    const base = await manager.findOneBy(EventEntity, {
      eventId: s.price_configuration_event_id!,
    });
    if (
      !base ||
      base.aggregateType !== 'product' ||
      base.aggregateId !== l.product_id ||
      base.syncStatus !== EventSyncStatus.SYNCED
    )
      return 'Precio histórico inexistente.';
    let state: ProductoCreadoPayload;
    if (base.eventType === ProductoCreadoPayload.eventType)
      state = ProductoCreadoPayload.fromJson(base.payload);
    else if (base.eventType === ProductoActualizadoPayload.eventType) {
      const update = ProductoActualizadoPayload.fromJson(base.payload);
      if (update.deleteProduct) return 'Precio de configuración desactivada.';
      state = update.after;
    } else return 'Evento de precio inválido.';
    const v = state.variants.find((v) => v.id === s.variant_id);
    const config = state.saleConfiguration;
    if (
      !v ||
      v.salePriceMinor !== s.normal_price_minor_snapshot ||
      (v.offerPriceMinor ?? null) !== s.offer_price_minor_snapshot ||
      v.standardCostMinor !== s.standard_cost_minor_snapshot ||
      String(config.mode) !== s.sale_mode_snapshot ||
      (config.mode === SaleMode.MEASURED &&
        (config.saleUnitId !== l.sale_unit_id ||
          config.priceReferenceQuantityAtomic !==
            s.price_reference_quantity_atomic_snapshot))
    )
      return 'Precio o costo no coincide con su configuración histórica.';
    return null;
  }
  static async validateHistory(
    manager: EntityManager,
    l: ConfirmedSaleLine,
  ): Promise<string | null> {
    const base = await manager.findOneBy(EventEntity, {
      eventId: l.configuration_event_id,
    });
    if (
      !base ||
      base.aggregateType !== 'product' ||
      base.aggregateId !== l.product_id ||
      base.syncStatus !== EventSyncStatus.SYNCED
    )
      return 'Configuración histórica inexistente.';
    let state: ProductoCreadoPayload;
    if (base.eventType === ProductoCreadoPayload.eventType)
      state = ProductoCreadoPayload.fromJson(base.payload);
    else if (base.eventType === ProductoActualizadoPayload.eventType) {
      const update = ProductoActualizadoPayload.fromJson(base.payload);
      if (update.deleteProduct)
        return 'No se puede vender desde una configuración desactivada.';
      state = update.after;
    } else return 'Evento de configuración inválido.';
    const v = state.variants.find((v) => v.id === l.snapshot.variant_id);
    if (!v) return 'La configuración no contiene la variante.';
    const mode = v.inventoryItemId
      ? 'direct'
      : v.recipeComponents.length
        ? 'recipe'
        : 'none';
    const expected = v.inventoryItemId
      ? [{ id: v.inventoryItemId, quantity: 1 }]
      : v.recipeComponents.map((c) => ({
          id: c.inventoryItemId,
          quantity: c.quantityAtomic,
        }));
    const actual = l.consumptions.map((c) => ({
      id: c.inventory_item_id,
      quantity: c.component_atomic,
    }));
    const order = (a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id);
    const config = state.saleConfiguration;
    if (
      mode !== l.consumption_mode ||
      !isDeepStrictEqual(expected.sort(order), actual.sort(order)) ||
      String(config.mode) !== l.snapshot.sale_mode_snapshot ||
      (config.mode === SaleMode.MEASURED &&
        (config.saleUnitId !== l.sale_unit_id ||
          config.priceReferenceQuantityAtomic !==
            l.snapshot.price_reference_quantity_atomic_snapshot))
    )
      return 'El consumo no coincide con la configuración histórica.';
    if (l.sale_unit_id) {
      const unit = await manager.findOneBy(UnitEntity, {
        unitId: l.sale_unit_id,
      });
      if (
        !unit ||
        Number(unit.atomicFactor) !==
          l.snapshot.sale_unit_atomic_factor_snapshot ||
        unit.code !== l.snapshot.sale_unit_code_snapshot ||
        unit.symbol !== l.snapshot.sale_unit_symbol_snapshot
      )
        return 'Unidad histórica inconsistente.';
    }
    return null;
  }
}
