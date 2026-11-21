import express from 'express';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import { configureRecoveryBodyParser } from '../../recovery/recovery-body-parser';
import { SupplierOrderConfirmedPayload } from './supplier-order-confirmed-payload';
import {
  supplierOrderCanTransition,
  SupplierOrderStatus,
} from './supplier-order-status';

describe('Pedidos S1: transporte y transiciones', () => {
  it('50 partidas caben en el parser HTTP vigente con sobre de evento', async () => {
    const fixtures = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../test/fixtures/supplier_orders_v1/contracts.json',
        ),
        'utf8',
      ),
    );
    const payload = SupplierOrderConfirmedPayload.fromJson(
      fixtures.documents.find((f) => f.name === '50 partidas').payload,
    ).toJson();
    const body = JSON.stringify({
      events: [
        {
          event_id: '00000000-0000-4000-8000-000000000001',
          aggregate_type: 'supplier_order',
          aggregate_id: payload.order_id,
          event_type: SupplierOrderConfirmedPayload.eventType,
          device_id: 'device',
          user_id: 'user',
          created_at_local: '2026-11-19T00:00:00.000Z',
          base_version: 1,
          base_server_sequence: null,
          payload,
        },
      ],
    });
    expect(Buffer.byteLength(body)).toBeLessThan(100 * 1024);
    const app = express();
    configureRecoveryBodyParser(app as any);
    app.post('/sync/push', (_req, res) => res.sendStatus(204));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/sync/push`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        },
      );
      expect(response.status).toBe(204);
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });
  it('terminales inmutables; parcial solo recibe/cierra; cancelar nunca deshace stock', () => {
    const states: SupplierOrderStatus[] = [
      'draft',
      'confirmed',
      'partial',
      'received',
      'closed',
      'cancelled',
    ];
    for (const state of ['received', 'closed', 'cancelled'] as const)
      for (const target of states)
        expect(supplierOrderCanTransition(state, target)).toBe(false);
    expect(supplierOrderCanTransition('partial', 'cancelled')).toBe(false);
    expect(supplierOrderCanTransition('partial', 'partial')).toBe(true);
    expect(supplierOrderCanTransition('partial', 'received')).toBe(true);
    expect(supplierOrderCanTransition('partial', 'closed')).toBe(true);
    expect(supplierOrderCanTransition('draft', 'confirmed')).toBe(true);
  });
});
