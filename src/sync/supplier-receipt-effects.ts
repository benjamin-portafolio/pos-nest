import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { SupplierOrderEntity } from '../entities/supplier-order.entity';
import { SupplierReceiptEntity } from '../entities/supplier-receipt.entity';
import { SupplierReceiptItemEntity } from '../entities/supplier-receipt-item.entity';
import { InventoryMovementEntity } from '../entities/inventory-movement.entity';
import { InventoryBalanceEntity } from '../entities/inventory-balance.entity';
import { EventEntity } from '../entities/event.entity';
import { PushEventDto } from './dto/push-events.dto';
import { SupplierReceiptConfirmedPayload } from './payloads/supplier-receipt-confirmed-payload';
import { SupplierOrderClosedPayload } from './payloads/supplier-order-closed-payload';

export function supplierIntentHash(value: unknown): string {
  const sorted = (v: any): any =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(sorted(value)))
    .digest('hex');
}
/** Used inside the existing per-event transaction, after the order lock/base check.
 * Stock is an additive ledger effect, just like sale consumption; resource
 * identity metadata is unchanged. Actual purchase price is only documentary.
 */
export class SupplierReceiptEffects {
  readonly refs: { refType: string; refId: string; relationship: string }[];
  readonly payload:
    | SupplierReceiptConfirmedPayload
    | SupplierOrderClosedPayload;
  private lines: any[] = [];
  private balances = new Map<string, InventoryBalanceEntity>();
  constructor(
    private m: EntityManager,
    private e: PushEventDto,
    private order: SupplierOrderEntity,
  ) {
    this.payload =
      e.event_type === SupplierReceiptConfirmedPayload.eventType
        ? SupplierReceiptConfirmedPayload.fromJson(e.payload)
        : SupplierOrderClosedPayload.fromJson(e.payload);
    this.refs = [
      { refType: 'supplier_order', refId: order.id, relationship: 'affects' },
      { refType: 'supplier', refId: order.supplierId, relationship: 'uses' },
    ];
  }
  async validate(): Promise<string | null> {
    const p = this.payload;
    this.lines = await this.m.query(
      `SELECT l.*,coalesce((SELECT sum(r.quantity_atomic)
      FROM supplier_receipt_items r WHERE r.order_item_id=l.id),0)::text received
      FROM supplier_order_items l WHERE l.order_id=$1 ORDER BY l.position`,
      [this.order.id],
    );
    if (p instanceof SupplierOrderClosedPayload) {
      if (this.order.status !== 'partial')
        return 'Solo un pedido parcial permite cerrar faltantes.';
      const pending = this.lines.filter(
        (l) => BigInt(l.quantity_atomic) > BigInt(l.received),
      );
      if (
        p.items.length !== pending.length ||
        p.items.some((i) => {
          const l = pending.find((l) => l.id === i.orderItemId);
          return (
            !l ||
            BigInt(i.closedQuantityAtomic) !==
              BigInt(l.quantity_atomic) - BigInt(l.received)
          );
        })
      )
        return 'El cierre debe acreditar exactamente todo el remanente.';
      return null;
    }
    if (!['confirmed', 'partial'].includes(this.order.status))
      return 'El pedido no admite más recepciones.';
    await this.m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'supplier_receipt:' + p.receiptId,
    ]);
    if (await this.m.existsBy(SupplierReceiptEntity, { id: p.receiptId }))
      return 'Identidad de recepción ocupada.';
    const catalog: any[] = await this.m.query(
      `SELECT v.variant_id,v.product_id,v.inventory_item_id,
      i.default_unit_id,u.dimension,u.atomic_factor,p.sale_mode,p.price_reference_quantity_atomic
      FROM product_variants v JOIN products p ON p.product_id=v.product_id
      JOIN inventory_items i ON i.inventory_item_id=v.inventory_item_id
      JOIN units u ON u.unit_id=i.default_unit_id
      JOIN variant_suppliers vs ON vs.variant_id=v.variant_id AND vs.supplier_id=$1
      JOIN suppliers s ON s.supplier_id=vs.supplier_id
      WHERE v.variant_id=ANY($2::uuid[]) AND v.active AND p.active AND i.active AND u.active AND s.active
      AND NOT EXISTS(SELECT 1 FROM recipe_components rc WHERE rc.variant_id=v.variant_id)
      AND (p.sale_mode='unit' AND u.dimension='count' OR p.sale_mode='measured'
      AND (SELECT dimension FROM units su WHERE su.unit_id=p.sale_unit_id)=u.dimension AND u.dimension IN ('mass','volume'))
      ORDER BY i.inventory_item_id FOR SHARE OF v,p,i,u,vs,s`,
      [this.order.supplierId, this.lines.map((l) => l.variant_id)],
    );
    const resources = [
      ...new Set(
        p.items
          .map(
            (i) =>
              this.lines.find((l) => l.id === i.orderItemId)?.inventory_item_id,
          )
          .filter(Boolean),
      ),
    ].sort() as string[];
    for (const id of resources) {
      const b = await this.m.findOne(InventoryBalanceEntity, {
        where: { inventoryItemId: id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!b) return 'El recurso no tiene saldo materializado.';
      this.balances.set(id, b);
    }
    for (const i of p.items) {
      const l = this.lines.find((l) => l.id === i.orderItemId);
      if (!l || BigInt(l.closed_quantity_atomic) !== 0n)
        return 'Partida ajena o faltante cerrado.';
      const c = catalog.find((c) => c.variant_id === l.variant_id);
      if (
        !c ||
        c.inventory_item_id !== l.inventory_item_id ||
        c.default_unit_id !== l.unit_id ||
        c.dimension !== l.dimension ||
        BigInt(c.atomic_factor) !== BigInt(l.unit_atomic_factor) ||
        BigInt(
          c.sale_mode === 'unit' ? 1 : c.price_reference_quantity_atomic,
        ) !== BigInt(l.reference_quantity_atomic) ||
        BigInt(i.referenceQuantityAtomic) !==
          BigInt(l.reference_quantity_atomic)
      )
        return 'Cambió el vínculo, actividad, recurso o unidad de la partida.';
      if (BigInt(l.received) + BigInt(i.quantityAtomic) > 9007199254740991n)
        return 'Acumulado fuera de rango.';
      if (
        BigInt(l.received) + BigInt(i.quantityAtomic) >
          BigInt(l.quantity_atomic) &&
        !i.overageAcknowledged
      )
        return 'El exceso requiere revisión explícita.';
      this.refs.push(
        { refType: 'product', refId: c.product_id, relationship: 'uses' },
        {
          refType: 'product_variant',
          refId: l.variant_id,
          relationship: 'uses',
        },
        { refType: 'unit', refId: l.unit_id, relationship: 'uses' },
        {
          refType: 'inventory_item',
          refId: l.inventory_item_id,
          relationship: 'affects',
        },
        {
          refType: 'inventory_movement',
          refId: i.movementId,
          relationship: 'affects',
        },
      );
    }
    // Combine deltas for variants sharing the same resource, and reject overflow
    // before saving any part of the document.
    for (const [id, b] of this.balances) {
      const delta = p.items
        .filter(
          (i) =>
            this.lines.find((l) => l.id === i.orderItemId).inventory_item_id ===
            id,
        )
        .reduce((sum, i) => sum + BigInt(i.quantityAtomic), 0n);
      if (
        [b.quantityOnHandAtomic, b.quantityAvailableAtomic].some((q) => {
          const n = BigInt(q) + delta;
          return n > 9007199254740991n || n < -9007199254740991n;
        })
      )
        return 'Saldo fuera de rango.';
    }
    this.refs.push({
      refType: 'supplier_receipt',
      refId: p.receiptId,
      relationship: 'affects',
    });
    this.refs.splice(
      0,
      this.refs.length,
      ...new Map(
        this.refs.map((r) => [
          r.refType + ':' + r.refId + ':' + r.relationship,
          r,
        ]),
      ).values(),
    );
    return null;
  }
  async apply(saved: EventEntity): Promise<void> {
    const p = this.payload;
    let status: string;
    if (p instanceof SupplierOrderClosedPayload) {
      for (const l of p.items)
        await this.m.query(
          'UPDATE supplier_order_items SET closed_quantity_atomic=$1 WHERE id=$2',
          [String(l.closedQuantityAtomic), l.orderItemId],
        );
      status = 'closed';
    } else {
      await this.m.insert(SupplierReceiptEntity, {
        id: p.receiptId,
        orderId: p.orderId,
        eventId: this.e.event_id,
        intentHash: supplierIntentHash(p.toJson()),
        baseEventId: p.baseEventId,
        occurredAtMs: String(p.occurredAtMs),
        totalMinor: String(p.totalMinor),
        active: true,
        version: 1,
        createdEventId: this.e.event_id,
        lastEventId: this.e.event_id,
        lastServerSequence: saved.serverSequence,
      });
      const touched = new Set<string>();
      for (const i of p.items) {
        const l = this.lines.find((l) => l.id === i.orderItemId);
        const b = this.balances.get(l.inventory_item_id)!;
        await this.m.insert(InventoryMovementEntity, {
          movementId: i.movementId,
          inventoryItemId: l.inventory_item_id,
          eventId: this.e.event_id,
          movementType: 'stock_receipt',
          quantityDeltaAtomic: String(i.quantityAtomic),
          totalCostMinor: null,
          createdAtLocal: new Date(this.e.created_at_local),
          serverSequence: saved.serverSequence,
        });
        b.quantityOnHandAtomic = (
          BigInt(b.quantityOnHandAtomic) + BigInt(i.quantityAtomic)
        ).toString();
        b.quantityAvailableAtomic = (
          BigInt(b.quantityAvailableAtomic) + BigInt(i.quantityAtomic)
        ).toString();
        if (!touched.has(l.inventory_item_id)) {
          b.version++;
          touched.add(l.inventory_item_id);
        }
        b.lastEventId = this.e.event_id;
        b.lastServerSequence = saved.serverSequence;
        await this.m.save(b);
        await this.m.insert(SupplierReceiptItemEntity, {
          id: i.movementId,
          receiptId: p.receiptId,
          orderId: p.orderId,
          orderItemId: i.orderItemId,
          quantityAtomic: String(i.quantityAtomic),
          actualPriceMinor: String(i.actualPriceMinor),
          totalMinor: String(i.totalMinor),
          movementId: i.movementId,
        });
        l.received = (BigInt(l.received) + BigInt(i.quantityAtomic)).toString();
      }
      status = this.lines.every(
        (l) => BigInt(l.received) >= BigInt(l.quantity_atomic),
      )
        ? 'received'
        : 'partial';
    }
    await this.m.update(
      SupplierOrderEntity,
      { id: p.orderId },
      {
        status,
        version: this.order.version + 1,
        lastEventId: this.e.event_id,
        lastServerSequence: saved.serverSequence,
      },
    );
  }
}
