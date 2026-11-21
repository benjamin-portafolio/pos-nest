import { SupplierReceiptConfirmedPayload } from '../sync/payloads/supplier-receipt-confirmed-payload';
import { SupplierOrderClosedPayload } from '../sync/payloads/supplier-order-closed-payload';
import { supplierIntentHash } from '../sync/supplier-receipt-effects';
import { EntityManager } from 'typeorm';
import { SupplierOrderDraftSavedPayload } from '../sync/payloads/supplier-order-draft-saved-payload';
import { SupplierOrderConfirmedPayload } from '../sync/payloads/supplier-order-confirmed-payload';
import { SupplierOrderCancelledPayload } from '../sync/payloads/supplier-order-cancelled-payload';
import {
  recoveryAssert as check,
  recoveryCompare as compare,
  recoveryHistory as history,
  recoveryMetadata as metadata,
} from './recovery-business-validation';

export async function validateRecoverySupplierOrders(m: EntityManager) {
  const [orphan] = await m.query(
    `SELECT o.id FROM supplier_orders o WHERE NOT EXISTS(SELECT 1 FROM events e WHERE e.aggregate_type='supplier_order' AND e.aggregate_id=o.id AND e.sync_status='synced') LIMIT 1`,
  );
  check(!orphan, 'supplier_orders', orphan?.id, 'missing_history');
  for await (const creator of history(
    m,
    `aggregate_type='supplier_order' AND event_type='supplier_order_draft_saved' AND payload->>'base_event_id' IS NULL`,
    [],
  )) {
    const id = creator.aggregate_id;
    let last: any = null;
    let doc:
      | SupplierOrderDraftSavedPayload
      | SupplierOrderConfirmedPayload
      | undefined;
    const received = new Map<string, bigint>();
    const closed = new Map<string, bigint>();
    let receiptCount = 0;
    let state = '';
    let version = 0;
    for await (const e of history(
      m,
      `aggregate_type='supplier_order' AND aggregate_id=$1`,
      [id],
    )) {
      const cancelled =
        e.event_type === SupplierOrderCancelledPayload.eventType;
      const isReceipt =
        e.event_type === SupplierReceiptConfirmedPayload.eventType;
      const isClosed = e.event_type === SupplierOrderClosedPayload.eventType;
      const p = isReceipt
        ? SupplierReceiptConfirmedPayload.fromJson(e.payload)
        : isClosed
          ? SupplierOrderClosedPayload.fromJson(e.payload)
          : cancelled
            ? SupplierOrderCancelledPayload.fromJson(e.payload)
            : e.event_type === SupplierOrderConfirmedPayload.eventType
              ? SupplierOrderConfirmedPayload.fromJson(e.payload)
              : SupplierOrderDraftSavedPayload.fromJson(e.payload);
      check(p.orderId === id, 'supplier_orders', id, 'identity');
      check(
        last
          ? p.baseEventId === last.event_id &&
              e.base_version === version &&
              (e.base_server_sequence === null ||
                BigInt(e.base_server_sequence) <= BigInt(last.server_sequence))
          : p.baseEventId === null &&
              e.base_version === 1 &&
              e.base_server_sequence === null,
        'supplier_orders',
        id,
        'base',
      );
      check(
        last
          ? isReceipt
            ? ['confirmed', 'partial'].includes(state)
            : isClosed
              ? state === 'partial'
              : state === 'draft' || (cancelled && state === 'confirmed')
          : !cancelled,
        'supplier_orders',
        id,
        'transition',
      );
      if (p instanceof SupplierReceiptConfirmedPayload) {
        receiptCount++;
        const [row] = await m.query(
          'SELECT * FROM supplier_receipts WHERE id=$1',
          [p.receiptId],
        );
        compare(
          row,
          {
            ...metadata(e, 1, e.event_id),
            id: p.receiptId,
            order_id: id,
            event_id: e.event_id,
            intent_hash: supplierIntentHash(p.toJson()),
            base_event_id: p.baseEventId,
            occurred_at_ms: String(p.occurredAtMs),
            total_minor: String(p.totalMinor),
          },
          'supplier_receipts',
          p.receiptId,
        );
        const rows = await m.query(
          'SELECT * FROM supplier_receipt_items WHERE receipt_id=$1',
          [p.receiptId],
        );
        check(
          rows.length === p.items.length,
          'supplier_receipts',
          p.receiptId,
          'items_count',
        );
        for (const item of p.items) {
          const original = doc?.items.find((l) => l.id === item.orderItemId);
          check(
            original &&
              item.referenceQuantityAtomic === original.referenceQuantityAtomic,
            'supplier_receipts',
            p.receiptId,
            'line_reference',
          );
          const qty =
            (received.get(item.orderItemId) ?? 0n) +
            BigInt(item.quantityAtomic);
          check(
            qty <= 9007199254740991n &&
              (qty <= BigInt(original!.quantityAtomic) ||
                item.overageAcknowledged),
            'supplier_receipts',
            p.receiptId,
            'overage',
          );
          received.set(item.orderItemId, qty);
          compare(
            rows.find((l) => l.order_item_id === item.orderItemId),
            {
              id: item.movementId,
              receipt_id: p.receiptId,
              order_id: id,
              order_item_id: item.orderItemId,
              quantity_atomic: String(item.quantityAtomic),
              actual_price_minor: String(item.actualPriceMinor),
              total_minor: String(item.totalMinor),
              movement_id: item.movementId,
            },
            'supplier_receipt_items',
            item.movementId,
          );
          const [movement] = await m.query(
            'SELECT * FROM inventory_movements WHERE movement_id=$1',
            [item.movementId],
          );
          compare(
            movement,
            {
              movement_id: item.movementId,
              inventory_item_id: original!.inventoryItemId,
              event_id: e.event_id,
              sale_item_id: null,
              sale_adjustment_id: null,
              reversal_of_movement_id: null,
              movement_type: 'stock_receipt',
              quantity_delta_atomic: String(item.quantityAtomic),
              total_cost_minor: null,
              reason: null,
              server_sequence: String(e.server_sequence),
            },
            'inventory_movements',
            item.movementId,
          );
          check(
            new Date(movement.created_at_local).getTime() ===
              new Date(e.created_at_local).getTime(),
            'inventory_movements',
            item.movementId,
            'date',
          );
        }
        state = doc!.items.every(
          (l) => (received.get(l.id) ?? 0n) >= BigInt(l.quantityAtomic),
        )
          ? 'received'
          : 'partial';
      } else if (p instanceof SupplierOrderClosedPayload) {
        const pending = doc!.items.filter(
          (l) => BigInt(l.quantityAtomic) > (received.get(l.id) ?? 0n),
        );
        check(
          p.items.length === pending.length,
          'supplier_orders',
          id,
          'close_count',
        );
        for (const item of p.items) {
          const original = pending.find((l) => l.id === item.orderItemId);
          check(
            original &&
              BigInt(item.closedQuantityAtomic) ===
                BigInt(original.quantityAtomic) -
                  (received.get(item.orderItemId) ?? 0n),
            'supplier_orders',
            id,
            'close_quantity',
          );
          closed.set(item.orderItemId, BigInt(item.closedQuantityAtomic));
        }
        state = 'closed';
      } else if (!cancelled) {
        const next = p as
          | SupplierOrderDraftSavedPayload
          | SupplierOrderConfirmedPayload;
        check(
          !doc || doc.supplierId === next.supplierId,
          'supplier_orders',
          id,
          'supplier_changed',
        );
        for (const line of next.items)
          check(
            !doc?.items.some(
              (l) => l.id === line.id && l.variantId !== line.variantId,
            ),
            'supplier_order_items',
            line.id,
            'identity_changed',
          );
        doc = next;
      }
      if (!isReceipt && !isClosed)
        state = cancelled
          ? 'cancelled'
          : e.event_type === SupplierOrderConfirmedPayload.eventType
            ? 'confirmed'
            : 'draft';
      last = e;
      version++;
    }
    check(doc && last, 'supplier_orders', id, 'empty_history');
    const [row] = await m.query('SELECT * FROM supplier_orders WHERE id=$1', [
      id,
    ]);
    compare(
      row,
      {
        ...metadata(last, version, creator.event_id),
        id,
        supplier_id: doc.supplierId,
        status: state,
        occurred_at_ms: String(doc.occurredAtMs),
        currency: doc.currency,
        supplier_name_snapshot: doc.supplierNameSnapshot,
        supplier_phone_snapshot: doc.supplierPhoneSnapshot,
        notes: doc.notes,
        total_minor: doc.totalMinor === null ? null : String(doc.totalMinor),
      },
      'supplier_orders',
      id,
    );
    const [count] = await m.query(
      'SELECT count(*)::int n FROM supplier_receipts WHERE order_id=$1',
      [id],
    );
    check(count.n === receiptCount, 'supplier_orders', id, 'receipt_count');
    const items = await m.query(
      'SELECT * FROM supplier_order_items WHERE order_id=$1 ORDER BY position',
      [id],
    );
    check(
      items.length === doc.items.length,
      'supplier_orders',
      id,
      'items_count',
    );
    for (let i = 0; i < items.length; i++) {
      const expected: any = {
        ...doc.items[i].toJson(),
        order_id: id,
        closed_quantity_atomic: (closed.get(doc.items[i].id) ?? 0n).toString(),
        position: String(i),
      };
      for (const field of [
        'unit_atomic_factor',
        'reference_quantity_atomic',
        'quantity_atomic',
        'quoted_price_minor',
        'total_minor',
      ])
        if (expected[field] !== null) expected[field] = String(expected[field]);
      compare(items[i], expected, 'supplier_order_items', items[i].id);
    }
  }
  const [orphanReceipt] = await m.query(
    "SELECT r.id FROM supplier_receipts r LEFT JOIN supplier_orders o ON o.id=r.order_id WHERE o.id IS NULL OR NOT EXISTS(SELECT 1 FROM events e WHERE e.event_id=r.event_id AND e.sync_status='synced' AND e.event_type='supplier_receipt_confirmed') LIMIT 1",
  );
  check(!orphanReceipt, 'supplier_receipts', orphanReceipt?.id, 'orphan');
  const [missingCreator] = await m.query(
    `SELECT e.aggregate_id FROM events e WHERE e.sync_status='synced' AND e.aggregate_type='supplier_order' AND NOT EXISTS(SELECT 1 FROM events c WHERE c.aggregate_type='supplier_order' AND c.aggregate_id=e.aggregate_id AND c.sync_status='synced' AND c.event_type='supplier_order_draft_saved' AND c.payload->>'base_event_id' IS NULL AND c.server_sequence<=e.server_sequence) LIMIT 1`,
  );
  check(
    !missingCreator,
    'supplier_orders',
    missingCreator?.aggregate_id,
    'creator_missing',
  );
}
