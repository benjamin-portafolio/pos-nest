import { readFileSync } from 'fs';
import { join } from 'path';
import {
  orderAmount,
  orderTotal,
  orderPayloadSize,
} from './supplier-order-json';
import { SupplierOrderDraftSavedPayload } from './supplier-order-draft-saved-payload';
import { SupplierOrderConfirmedPayload } from './supplier-order-confirmed-payload';
import { SupplierReceiptConfirmedPayload } from './supplier-receipt-confirmed-payload';
import { SupplierOrderCancelledPayload } from './supplier-order-cancelled-payload';
import { SupplierOrderClosedPayload } from './supplier-order-closed-payload';
import { SupplierReplenishmentPatch } from './supplier-replenishment-patch';
const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '../../../test/fixtures/supplier_orders_v1/contracts.json'),
    'utf8',
  ),
);
const parsers = {
  draft: SupplierOrderDraftSavedPayload,
  confirmed: SupplierOrderConfirmedPayload,
  receipt: SupplierReceiptConfirmedPayload,
  cancelled: SupplierOrderCancelledPayload,
  closed: SupplierOrderClosedPayload,
};
describe('Pedidos S1: fixtures compartidos', () => {
  for (const f of fixtures.documents)
    it(f.name, () => {
      const parse = () => parsers[f.kind].fromJson(f.payload).toJson();
      if (f.valid) expect(parse()).toEqual(f.payload);
      else expect(parse).toThrow();
    });
  for (const f of fixtures.patches)
    it(f.name, () => {
      const parse = () =>
        SupplierReplenishmentPatch.fromJson(f.payload).toJson();
      if (f.valid) expect(parse()).toEqual(f.payload);
      else expect(parse).toThrow();
    });
  for (const f of fixtures.money)
    it('redondeo ' + JSON.stringify(f), () =>
      expect(orderAmount(f.price, f.quantity, f.reference)).toBe(f.total),
    );
  it('overflow y bytes UTF8', () => {
    expect(() => orderAmount(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow();
    expect(() => orderTotal([Number.MAX_SAFE_INTEGER, 1])).toThrow();
    expect(() => orderPayloadSize({ x: 'á'.repeat(50000) })).toThrow();
  });
});
