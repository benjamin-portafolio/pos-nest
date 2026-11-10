import { VentaConfirmadaPayload } from '../sync/payloads/venta-confirmada.payload';
import { VentaAnuladaPayload } from '../sync/payloads/venta-anulada.payload';
import { DevolucionVentaRegistradaPayload } from '../sync/payloads/devolucion-venta-registrada.payload';
import { SaleAdjustmentRules } from '../sync/payloads/sale-adjustment-rules';
import { parseSaleAdjustmentPayload } from '../sync/payloads/sale-adjustment-data';
import { OperacionVentaConciliadaPayload } from '../sync/payloads/operacion-venta-conciliada.payload';
import { CajaAbiertaPayload } from '../sync/payloads/caja-abierta.payload';
import { CashOperationPayload } from '../sync/payloads/cash-operation.payload';
import { EntityManager } from 'typeorm';
import {
  ProductoCreadoPayload,
  productVariantNameRefId,
} from '../sync/payloads/producto-creado.payload';
import { ProductoActualizadoPayload } from '../sync/payloads/producto-actualizado.payload';
import {
  CategoriaEventContract,
  CATEGORIA_MOVIDA,
} from '../sync/payloads/categoria-event-contract';
import { CategoriaEliminadaPayload } from '../sync/payloads/categoria-eliminada.payload';
import { AbonoClienteRegistradoPayload } from '../sync/payloads/abono-cliente-registrado.payload';
import { MovimientoFinancieroRegistradoPayload } from '../sync/payloads/movimiento-financiero-registrado.payload';
import { SaldoCuentaInicialDeclaradoPayload } from '../sync/payloads/saldo-cuenta-inicial-declarado.payload';
import { createHash } from 'node:crypto';
import { canonical } from './recovery-contract';
import { RecursoInventarioCreadoPayload } from '../sync/payloads/recurso-inventario-creado.payload';
import { MovimientoInventarioRegistradoPayload } from '../sync/payloads/movimiento-inventario-registrado.payload';

/** Semantic set shared by validation and publication; never executes an event. */
export function recoveryEventReferences(
  e: any,
  context: {
    deletedVariants?: any[];
    originalSale?: VentaConfirmadaPayload;
  } = {},
) {
  const deletedVariants = context.deletedVariants ?? [];
  const refs = [
    {
      ref_type: e.aggregate_type,
      ref_id: e.aggregate_id,
      relationship: 'affects',
    },
  ];
  if (e.event_type === RecursoInventarioCreadoPayload.eventType) {
    const p = RecursoInventarioCreadoPayload.fromJson(e.payload);
    refs.push({
      ref_type: 'unit',
      ref_id: p.defaultUnitId,
      relationship: 'uses',
    });
    if (p.initialMovement)
      refs.push({
        ref_type: 'inventory_movement',
        ref_id: p.initialMovement.movementId,
        relationship: 'affects',
      });
  }
  if (e.event_type === MovimientoInventarioRegistradoPayload.eventType) {
    const p = MovimientoInventarioRegistradoPayload.fromJson(e.payload);
    refs.push({
      ref_type: 'inventory_movement',
      ref_id: p.movement.movementId,
      relationship: 'affects',
    });
  }
  if (e.event_type === AbonoClienteRegistradoPayload.eventType) {
    const p = AbonoClienteRegistradoPayload.fromJson(e.payload);
    refs.push(
      {
        ref_type: 'customer_account',
        ref_id: p.clienteId,
        relationship: 'affects',
      },
      { ref_type: 'cliente', ref_id: p.clienteId, relationship: 'uses' },
    );
  }
  if (e.event_type === MovimientoFinancieroRegistradoPayload.eventType) {
    const p = MovimientoFinancieroRegistradoPayload.fromJson(e.payload);
    refs.push({
      ref_type: 'financial_category',
      ref_id: p.categoryId,
      relationship: 'uses',
    });
  }
  if (e.event_type === SaldoCuentaInicialDeclaradoPayload.eventType)
    refs.push({
      ref_type: SaldoCuentaInicialDeclaradoPayload.slotRefType,
      ref_id: SaldoCuentaInicialDeclaradoPayload.slotRefId,
      relationship: 'requires_unique',
    });
  if (
    e.event_type === 'espacio_creado' &&
    typeof e.payload.identificacion === 'string' &&
    e.payload.identificacion.trim()
  )
    refs.push({
      ref_type: 'espacio_identificacion',
      ref_id: e.payload.identificacion.trim(),
      relationship: 'requires_unique',
    });
  if (e.event_type === CATEGORIA_MOVIDA) {
    const p = CategoriaEventContract.parseCategoriaMovidaPayload(e.payload);
    if (!('error' in p))
      refs.push({
        ref_type: 'category',
        ref_id: p.displacedCategoryId,
        relationship: 'affects',
      });
  }
  if (e.event_type === CategoriaEliminadaPayload.eventType) {
    const p = CategoriaEliminadaPayload.fromJson(e.payload);
    for (const x of p.shiftedCategories)
      refs.push({
        ref_type: 'category',
        ref_id: x.categoryId,
        relationship: 'affects',
      });
    for (const x of p.linkedProducts)
      refs.push({
        ref_type: 'product',
        ref_id: x.productId,
        relationship: 'affects',
      });
    if (p.productResolution.type === 'move')
      refs.push({
        ref_type: 'category',
        ref_id: p.productResolution.destinationCategory.categoryId,
        relationship: 'uses',
      });
  }
  if (
    [
      ProductoCreadoPayload.eventType,
      ProductoActualizadoPayload.eventType,
    ].includes(e.event_type)
  ) {
    const update =
      e.event_type === ProductoActualizadoPayload.eventType
        ? ProductoActualizadoPayload.fromJson(e.payload)
        : null;
    const p = update?.after ?? ProductoCreadoPayload.fromJson(e.payload);
    const add = (ref_type: string, ref_id: string, relationship = 'affects') =>
      refs.push({ ref_type, ref_id, relationship });
    for (const state of update
      ? [update.before, ...(update.deleteProduct ? [] : [update.after])]
      : [p])
      for (const v of state.variants) {
        if (v.suppliers != null) {
          add('variant_suppliers', v.id);
          for (const supplier of v.suppliers)
            add('supplier', supplier.supplierId, 'uses');
        }
      }
    for (const v of [...(update?.removedVariants ?? []), ...deletedVariants]) {
      add('product_variant', v.id ?? v.variant_id);
      add('recipe', v.id ?? v.variant_id);
    }
    if (update?.deleteProduct && update.before.knowsSuppliers)
      for (const v of deletedVariants) {
        add('variant_suppliers', v.variant_id);
        for (const x of v.suppliers ?? [])
          add('supplier', x.supplier_id, 'uses');
      }
    if (!update?.deleteProduct) {
      for (const v of p.variants) {
        add('product_variant', v.id);
        if (v.nameKey !== null)
          add(
            'product_variant_name',
            productVariantNameRefId(e.aggregate_id, v.nameKey),
            'requires_unique',
          );
        if (v.recipeComponents.length || update) add('recipe', v.id);
      }
      for (const d of p.inventoryDependencies)
        add('inventory_item', d.refId, 'uses');
      if (p.categoryId) add('category', p.categoryId, 'uses');
      if (p.saleConfiguration.mode === 'measured')
        add('unit', p.saleConfiguration.saleUnitId, 'uses');
    }
  }
  const add = (ref_type: string, ref_id: string, relationship = 'affects') =>
    refs.push({ ref_type, ref_id, relationship });
  if (e.event_type === VentaConfirmadaPayload.eventType) {
    const p = VentaConfirmadaPayload.fromJson(e.payload);
    if (p.paymentId) add('payment', p.paymentId);
    if (p.clienteId) add('cliente', p.clienteId, 'uses');
    if (p.paymentMethod === 'credit') {
      add('credit', e.aggregate_id);
      add('customer_account', p.clienteId!);
    }
    for (const l of p.lines) {
      add('sale_item', l.sale_item_id);
      add('product', l.product_id, 'uses');
      add('product_variant', l.snapshot.variant_id, 'uses');
      add('recipe', l.snapshot.variant_id, 'uses');
      if (l.sale_unit_id) add('unit', l.sale_unit_id, 'uses');
      for (const c of l.consumptions) {
        add('inventory_item', c.inventory_item_id, 'uses');
        if (c.movement_id) add('inventory_movement', c.movement_id);
      }
    }
  }
  if (
    [
      VentaAnuladaPayload.eventType,
      DevolucionVentaRegistradaPayload.eventType,
    ].includes(e.event_type)
  ) {
    if (!context.originalSale)
      throw new Error(
        'Historical confirmation is required for adjustment refs',
      );
    refs.push(
      ...SaleAdjustmentRules.refs(
        parseSaleAdjustmentPayload(e.payload),
        context.originalSale,
      ),
    );
  }
  if (e.event_type === OperacionVentaConciliadaPayload.eventType)
    refs.push(...OperacionVentaConciliadaPayload.fromJson(e.payload).refs());
  if (e.event_type === CajaAbiertaPayload.eventType)
    add('cash_device', e.device_id, 'requires_unique');
  if (
    [
      VentaConfirmadaPayload.eventType,
      AbonoClienteRegistradoPayload.eventType,
      MovimientoFinancieroRegistradoPayload.eventType,
      VentaAnuladaPayload.eventType,
      DevolucionVentaRegistradaPayload.eventType,
    ].includes(e.event_type)
  ) {
    const cash = CashOperationPayload.fromEvent(e);
    if (cash) {
      add('cash_session', cash.cash.sessionId, 'uses');
      add('cash_movement', cash.cash.movementId);
    }
  }
  return [...new Map(refs.map((r) => [canonical(r), r])).values()].map((r) => ({
    ...r,
    event_ref_id: recoveryReferenceId([
      e.event_id,
      r.ref_type,
      r.ref_id,
      r.relationship,
    ]),
    event_id: e.event_id,
    server_sequence: String(e.server_sequence),
    source: 'server',
  }));
}

export function recoveryReferenceId(values: string[]) {
  const bytes = createHash('sha1')
    .update(Buffer.from('edca57ade7135b349658a340690a788f', 'hex'))
    .update(canonical(values))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function recoveryReferenceContext(m: EntityManager, e: any) {
  const result: {
    deletedVariants?: any[];
    originalSale?: VentaConfirmadaPayload;
  } = {};
  if (
    [
      VentaAnuladaPayload.eventType,
      DevolucionVentaRegistradaPayload.eventType,
    ].includes(e.event_type)
  ) {
    const a = parseSaleAdjustmentPayload(e.payload),
      [confirmation] = await m.query(
        'SELECT payload FROM events WHERE event_id=$1',
        [a.confirmation_event_id],
      );
    if (confirmation)
      result.originalSale = VentaConfirmadaPayload.fromJson(
        confirmation.payload,
      );
  }
  if (
    e.event_type === ProductoActualizadoPayload.eventType &&
    ProductoActualizadoPayload.fromJson(e.payload).deleteProduct
  ) {
    const rows = await m.query(
      'SELECT variant_id FROM product_variants WHERE product_id=$1',
      [e.aggregate_id],
    );
    for (const row of rows)
      row.suppliers = await m.query(
        'SELECT supplier_id FROM variant_suppliers WHERE variant_id=$1',
        [row.variant_id],
      );
    result.deletedVariants = rows;
  }
  return result;
}
