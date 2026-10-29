import { SaleAdjustmentCommandContract } from './sale-adjustment-command-contract';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { VentaConfirmadaPayload } from './venta-confirmada.payload';
import { VentaAnuladaPayload } from './venta-anulada.payload';
import { DevolucionVentaRegistradaPayload } from './devolucion-venta-registrada.payload';
import { parseSaleAdjustmentPayload } from './sale-adjustment-data';
import { SaleAdjustmentRules } from './sale-adjustment-rules';
import { SaleAdjustmentDeliveryPolicy } from './sale-adjustment-delivery-policy';
import { SaleAdjustmentCreditRules } from './sale-adjustment-credit-rules';
import { OperacionVentaConciliadaPayload } from './operacion-venta-conciliada.payload';
const bytes = readFileSync(
  resolve(__dirname, '../../../contracts/sale_adjustments/v1.json'),
);
const f = JSON.parse(bytes.toString());
it('shared fixture digest (Dart and TypeScript pin the same bytes)', () =>
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '494a26a085fa980dfeeb4e6279c4cb9b1a5007f99f65a0c4170f164ec77252e2',
  ));
for (const v of f.arithmetic)
  it(`cumulative ${v.total} ${v.before}→${v.after}`, () =>
    expect(
      SaleAdjustmentRules.cumulative(v.total, v.after, v.original) -
        SaleAdjustmentRules.cumulative(v.total, v.before, v.original),
    ).toBe(v.expected));
for (const c of f.cases)
  for (const mode of ['standalone', 'server_sync'])
    it(`${mode} ${c.name}`, () => {
      const run = () => {
        const original = VentaConfirmadaPayload.fromJson(c.original);
        const p = (
          c.payload.kind === 'void'
            ? VentaAnuladaPayload.fromJson(c.payload)
            : DevolucionVentaRegistradaPayload.fromJson(c.payload)
        ).adjustment;
        const history = c.history.map(parseSaleAdjustmentPayload);
        SaleAdjustmentRules.validate(
          p,
          original,
          '00000000-0000-4000-8000-000000000014',
          '00000000-0000-4000-8000-000000000001',
          history,
        );
        if (c.cash_context) {
          const x = c.cash_context;
          SaleAdjustmentRules.validateCash(
            p,
            x.enabled,
            x.open,
            x.session_id,
            x.opening_event_id,
          );
        }
        if (c.expected_money) {
          expect(SaleAdjustmentRules.paidMoneyEffects(p)).toEqual(
            c.expected_money,
          );
          expect(p.settlement.cash!.session_id).not.toBe(
            c.closed_cut.session_id,
          );
        }
        expect(p).toEqual(c.payload);
        const refs = SaleAdjustmentRules.refs(p, original);
        expect(refs).toContainEqual({
          ref_type: 'sale',
          ref_id: p.sale_id,
          relationship: 'affects',
        });
        expect(
          refs.map((r) => `${r.ref_type}/${r.ref_id}/${r.relationship}`).sort(),
        ).toEqual(c.expected_refs);
        const entry = SaleAdjustmentCommandContract.prepare(
          { payload: p, userId: 'operator', deviceId: 'terminal' },
          original,
          p.sale_id,
          p.confirmation_event_id,
          history,
          mode,
          true,
        );
        expect(entry.event.delivery_status).toBe(
          mode === 'standalone' ? 'not_required' : 'pending',
        );
        expect(entry.event.base_version).toBe(p.expected_revision + 1);
        expect(entry.refs).toEqual(refs);
        expect(SaleAdjustmentDeliveryPolicy.forMode(mode, true)).toEqual({
          delivery_status: mode === 'standalone' ? 'not_required' : 'pending',
          persist_refs: mode === 'server_sync',
        });
      };
      if (c.valid) run();
      else expect(run).toThrow();
    });
for (const c of f.fifo)
  it(c.name, () => {
    const run = () => SaleAdjustmentCreditRules.allocate(c.charges, c.payments);
    if (c.valid === false) expect(run).toThrow();
    else expect(run()).toEqual(c.expected);
  });
for (const c of f.reconciliations)
  it(c.name, () => {
    const run = () => {
      const p = OperacionVentaConciliadaPayload.fromJson(c.payload),
        canonical = f.reconciliations[0].payload;
      p.validateIncident(
        canonical.incident_id,
        canonical.sale_id,
        canonical.loser_event_id,
        canonical.winner_event_id,
        canonical.official_base_event_id,
        1,
        f.reconciliation_evidence,
        false,
      );
      expect(p.toJson()).toEqual(c.payload);
      expect(p.refs().some((r) => r.ref_type === 'sale_incident')).toBe(true);
      expect(() =>
        p.validateIncident(
          canonical.incident_id,
          canonical.sale_id,
          canonical.loser_event_id,
          canonical.winner_event_id,
          canonical.official_base_event_id,
          1,
          f.reconciliation_evidence,
          true,
        ),
      ).toThrow();
    };
    if (c.valid) run();
    else expect(run).toThrow();
  });
it('temporary gate; standalone independent of server readiness', () => {
  expect(
    SaleAdjustmentDeliveryPolicy.forMode('standalone', false).delivery_status,
  ).toBe('not_required');
  expect(() =>
    SaleAdjustmentDeliveryPolicy.forMode('server_sync', false),
  ).toThrow();
});
it('effective base and causal statuses', () => {
  expect(
    SaleAdjustmentDeliveryPolicy.resolveBase('base', ['confirmation'], {
      base: { status: 'accepted', server_sequence: 71 },
      confirmation: { status: 'accepted', server_sequence: 12 },
    }),
  ).toEqual({ status: 'ready', base_server_sequence: 71 });
  expect(
    SaleAdjustmentDeliveryPolicy.resolveBase('base', ['confirmation'], {
      base: { status: 'pending' },
      confirmation: { status: 'accepted', server_sequence: 12 },
    }).status,
  ).toBe('pending');
  expect(SaleAdjustmentDeliveryPolicy.resolveBase('base', [], {}).status).toBe(
    'pending',
  );
  for (const status of ['rejected', 'conflict', 'not_required'])
    expect(
      SaleAdjustmentDeliveryPolicy.resolveBase('base', [], { base: { status } })
        .status,
    ).toBe('incident');
});

it('stable identity excludes only transport metadata', () => {
  const c = f.cases[0],
    p = parseSaleAdjustmentPayload(c.payload),
    original = VentaConfirmadaPayload.fromJson(c.original),
    command = { payload: p, userId: 'operator', deviceId: 'terminal' };
  const a = SaleAdjustmentCommandContract.prepare(
    command,
    original,
    p.sale_id,
    p.confirmation_event_id,
    [],
    'standalone',
  ).event;
  expect(
    SaleAdjustmentCommandContract.sameIntention(a, {
      ...a,
      base_server_sequence: 71,
      delivery_status: 'delivered',
    }),
  ).toBe(true);
  expect(
    SaleAdjustmentCommandContract.sameIntention(a, {
      ...a,
      payload: { ...a.payload, reason: 'Otra intención' },
    }),
  ).toBe(false);
  expect(
    SaleAdjustmentCommandContract.sameIntention(a, { ...a, user_id: 'other' }),
  ).toBe(false);
  expect(() =>
    SaleAdjustmentCommandContract.prepare(
      command,
      original,
      p.sale_id,
      p.confirmation_event_id,
      [],
      'server_sync',
    ),
  ).toThrow();
});
it('normalization and event family are explicit', () => {
  const j = f.cases[0].payload;
  expect(
    VentaAnuladaPayload.fromJson({ ...j, reason: '  Corrección documentada  ' })
      .adjustment.reason,
  ).toBe('Corrección documentada');
  expect(() => DevolucionVentaRegistradaPayload.fromJson(j)).toThrow();
  expect(() =>
    VentaAnuladaPayload.fromJson({ ...j, schema_version: 2 }),
  ).toThrow();
});
