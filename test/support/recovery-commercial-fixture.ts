/** A newly authored synthetic commercial history. Every business fact is applied
 * by the normal receiver before any package is built. Never repairs a rescue. */
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ProductoCreadoPayload } from '../../src/sync/payloads/producto-creado.payload';
import { SyncService } from '../../src/sync/sync.service';
import { SyncConflictService } from '../../src/sync/sync-conflict.service';
import { CategoriaEventHandler } from '../../src/sync/categoria-event.handler';
import { ProductoEventHandler } from '../../src/sync/producto-event.handler';
import { InventoryEventHandler } from '../../src/sync/inventory-event.handler';
import { VentaEventHandler } from '../../src/sync/venta-event.handler';
import { ClienteEventHandler } from '../../src/sync/cliente-event.handler';
import { ProveedorEventHandler } from '../../src/sync/proveedor-event.handler';
import { AbonoClienteEventHandler } from '../../src/sync/abono-cliente-event.handler';
import { FinancialCategoryEventHandler } from '../../src/sync/financial-category-event.handler';
import { FinancialEntryEventHandler } from '../../src/sync/financial-entry-event.handler';
import { CashEventHandler } from '../../src/sync/cash-event.handler';
import { AccountBalanceBaselineEventHandler } from '../../src/sync/account-balance-baseline-event.handler';
import { SaleAdjustmentEventHandler } from '../../src/sync/sale-adjustment-event.handler';
import { CustomerCreditProjector } from '../../src/sync/customer-credit.projector';
import { SaleAdjustmentRules } from '../../src/sync/payloads/sale-adjustment-rules';
import { saleReconciliationEvidence } from '../../src/sync/payloads/sale-reconciliation-evidence';
import { parseSaleAdjustmentPayload } from '../../src/sync/payloads/sale-adjustment-data';
import { CajaCerradaPayload } from '../../src/sync/payloads/caja-cerrada.payload';
import { CashMovementEvidence } from '../../src/sync/payloads/cash-movement-evidence';
import {
  RECOVERY_COLUMNS,
  RECOVERY_KEYS,
} from '../../src/recovery/recovery-logical-schema';
import { canonical, sha256 } from '../../src/recovery/recovery-contract';
import { recoveryReferenceId } from '../../src/recovery/recovery-event-references';

export async function authorCommercialRecoveryFixture(
  db: DataSource,
  sourceManifest: any,
  extraSuppliers = 0,
) {
  if (
    !Number.isInteger(extraSuppliers) ||
    extraSuppliers < 0 ||
    extraSuppliers > 20000
  )
    throw new Error('Fixture volume outside declared range');
  const conflicts = new SyncConflictService(),
    credit = new CustomerCreditProjector();
  const service = new SyncService(
    db,
    { notifyEventsAvailable: async () => {} } as any,
    conflicts,
    new CategoriaEventHandler(conflicts),
    new ProductoEventHandler(conflicts),
    new InventoryEventHandler(conflicts),
    new VentaEventHandler(conflicts, credit),
    new ClienteEventHandler(conflicts),
    new AbonoClienteEventHandler(credit, conflicts),
    new FinancialCategoryEventHandler(conflicts),
    new FinancialEntryEventHandler(conflicts),
    new CashEventHandler(conflicts),
    new AccountBalanceBaselineEventHandler(conflicts),
    new ProveedorEventHandler(conflicts),
    new SaleAdjustmentEventHandler(credit, conflicts),
  );
  const device = 'recovery-fixture-source-A',
    user = 'fixture-operator';
  let local = 0,
    clock = 1794182400000;
  const events = new Map<string, any>();
  async function push(
    type: string,
    aggregate: string,
    id: string,
    payload: any,
    baseVersion = 1,
    baseSequence: number | null = null,
    status = 'accepted',
  ) {
    if (type === 'producto_creado') {
      payload = ProductoCreadoPayload.fromJson(payload).toJson();
      for (const v of payload.variants) {
        v.sku = null;
        v.is_default = false;
        if (!v.inventory_configuration)
          v.inventory_configuration = { enabled: false, components: null };
      }
    }
    const eventId = payload.event_id ?? randomUUID();
    clock += 1000;
    const e = {
      event_id: eventId,
      aggregate_type: aggregate,
      aggregate_id: id,
      event_type: type,
      device_id: device,
      user_id: user,
      local_sequence: ++local,
      created_at_local: new Date(clock).toISOString(),
      base_version: baseVersion,
      base_server_sequence: baseSequence,
      payload,
    };
    if (payload.occurred_at_ms !== undefined) {
      e.created_at_local = new Date(payload.occurred_at_ms).toISOString();
      clock = Math.max(clock, payload.occurred_at_ms);
    }
    const r = (await service.pushEvents({ device_id: device, events: [e] }))
      .results[0];
    if (r.status !== status) throw new Error(type + ': ' + JSON.stringify(r));
    events.set(eventId, { ...e, sequence: r.server_sequence });
    return { ...e, sequence: r.server_sequence! };
  }
  const category = randomUUID(),
    supplier = randomUUID(),
    customer = randomUUID();
  const cat = await push('categoria_creada', 'category', category, {
    name: 'Categoría original',
    color_key: 'blue',
    sort_order: 0,
  });
  const supplied = await push('proveedor_creado', 'supplier', supplier, {
    name: 'Proveedor acreditado',
    phone: null,
    notes: null,
  });
  const client = await push('cliente_creado', 'cliente', customer, {
    nombre: 'Cliente completo',
    telefono: null,
  });
  const units = await db.query('SELECT * FROM units'),
    piece = units.find((u) => u.code === 'piece'),
    gram = units.find((u) => u.code === 'kg');
  const resource = randomUUID(),
    measuredResource = randomUUID();
  const resourceEvent = await push(
    'recurso_inventario_creado',
    'inventory_item',
    resource,
    {
      inventory_item: {
        inventory_item_id: resource,
        name: 'Recurso original',
        default_unit_id: piece.unit_id,
      },
      initial_movement: {
        movement_id: randomUUID(),
        movement_type: 'initial_balance',
        quantity_delta_atomic: 100,
        reason: null,
        reversal_of_movement_id: null,
        total_cost_minor: null,
      },
    },
  );
  await push('recurso_inventario_creado', 'inventory_item', measuredResource, {
    inventory_item: {
      inventory_item_id: measuredResource,
      name: 'Recurso medido',
      default_unit_id: gram.unit_id,
    },
    initial_movement: {
      movement_id: randomUUID(),
      movement_type: 'initial_balance',
      quantity_delta_atomic: 100,
      reason: null,
      reversal_of_movement_id: null,
      total_cost_minor: null,
    },
  });
  const product = randomUUID(),
    variant = randomUUID(),
    measuredProduct = randomUUID(),
    measuredVariant = randomUUID(),
    recipeProduct = randomUUID(),
    recipeVariant = randomUUID();
  const productPayload = {
    product: {
      name: 'Histórico',
      category_id: category,
      sale_configuration: { mode: 'unit' },
    },
    variants: [
      {
        variant_id: variant,
        name: null,
        sku: null,
        barcode: null,
        sale_price_minor: 500,
        offer_price_minor: 450,
        standard_cost_minor: 300,
        minimum_stock_atomic: 2,
        inventory_item_id: resource,
        recipe_components: [],
        sort_order: 0,
        suppliers: [
          {
            supplier_id: supplier,
            quoted_price_minor: 200,
            quoted_at_ms: clock,
          },
        ],
      },
    ],
    dependencies: [
      {
        ref_type: 'category',
        ref_id: category,
        depends_on_event_id: cat.event_id,
      },
      { ref_type: 'inventory_item', ref_id: resource },
      { ref_type: 'supplier', ref_id: supplier },
    ],
  };
  const configuration = await push(
    'producto_creado',
    'product',
    product,
    productPayload,
  );
  const measuredConfig = await push(
    'producto_creado',
    'product',
    measuredProduct,
    {
      product: {
        name: 'Medido',
        category_id: null,
        sale_configuration: {
          mode: 'measured',
          sale_unit_id: gram.unit_id,
          price_reference_quantity_atomic: 1000,
        },
      },
      variants: [
        {
          variant_id: measuredVariant,
          name: null,
          sku: null,
          barcode: null,
          sale_price_minor: 33333,
          offer_price_minor: null,
          standard_cost_minor: 16667,
          minimum_stock_atomic: null,
          inventory_item_id: measuredResource,
          recipe_components: [],
          sort_order: 0,
          suppliers: [],
        },
      ],
      dependencies: [
        { ref_type: 'unit', ref_id: gram.unit_id },
        { ref_type: 'inventory_item', ref_id: measuredResource },
      ],
    },
  );
  const recipeConfig = await push('producto_creado', 'product', recipeProduct, {
    product: {
      name: 'Receta',
      category_id: null,
      sale_configuration: { mode: 'unit' },
    },
    variants: [
      {
        variant_id: recipeVariant,
        name: null,
        sku: null,
        barcode: null,
        sale_price_minor: 300,
        offer_price_minor: null,
        standard_cost_minor: null,
        minimum_stock_atomic: null,
        inventory_item_id: null,
        inventory_configuration: {
          enabled: true,
          components: [{ inventory_item_id: resource, quantity_atomic: 2 }],
        },
        sort_order: 0,
        suppliers: [],
      },
    ],
    dependencies: [{ ref_type: 'inventory_item', ref_id: resource }],
  });
  const session = randomUUID(),
    opening = await push('caja_abierta', 'cash_session', session, {
      opening_minor: 100,
      opened_at_ms: clock + 1000,
      previous_close_event_id: null,
    });
  async function sale(
    method: string,
    measured = false,
    recipe = false,
    cash = false,
  ) {
    const saleId = randomUUID(),
      itemId = randomUUID(),
      movement = randomUUID(),
      paymentId = method === 'credit' ? null : randomUUID();
    const config = measured
      ? measuredConfig
      : recipe
        ? recipeConfig
        : configuration;
    const count = measured ? 3 : 2,
      total = measured ? 100 : recipe ? 600 : 1000;
    const payload: any = {
      payment_id: paymentId,
      payment_method: method,
      total_minor: total,
      received_minor:
        method === 'cash' ? total + 1000 : method === 'transfer' ? total : 0,
      change_minor: method === 'cash' ? 1000 : 0,
      currency: 'MXN',
      cliente_id: method === 'credit' ? customer : null,
      cliente_event_id: method === 'credit' ? client.event_id : null,
      cliente_nombre: method === 'credit' ? 'Cliente completo' : null,
      occurred_at_ms: clock + 1000,
      payment_reference: null,
      lines: [
        {
          sale_item_id: itemId,
          product_id: config.aggregate_id,
          configuration_event_id: config.event_id,
          snapshot: {
            variant_id: measured
              ? measuredVariant
              : recipe
                ? recipeVariant
                : variant,
            product_name_snapshot: measured
              ? 'Medido'
              : recipe
                ? 'Receta'
                : 'Histórico',
            variant_name_snapshot: null,
            sale_mode_snapshot: measured ? 'measured' : 'unit',
            quantity: measured ? null : count,
            measured_quantity_atomic: measured ? count : null,
            unit_price_minor: measured ? 33333 : recipe ? 300 : 500,
            standard_cost_minor_snapshot: measured
              ? 16667
              : recipe
                ? null
                : 300,
            price_reference_quantity_atomic_snapshot: measured ? 1000 : null,
            sale_unit_code_snapshot: measured ? gram.code : null,
            sale_unit_symbol_snapshot: measured ? gram.symbol : null,
            sale_unit_atomic_factor_snapshot: measured
              ? Number(gram.atomic_factor)
              : null,
          },
          consumption_mode: recipe ? 'recipe' : 'direct',
          sale_unit_id: measured ? gram.unit_id : null,
          consumptions: [
            {
              inventory_item_id: measured ? measuredResource : resource,
              component_atomic: recipe ? 2 : 1,
              quantity_delta_atomic: recipe ? -4 : -count,
              movement_id: movement,
              movement_type: 'sale_consumption',
              total_cost_minor: null,
            },
          ],
        },
      ],
      dependency_event_ids: [
        config.event_id,
        ...(method === 'credit' ? [client.event_id] : []),
        ...(cash ? [opening.event_id] : []),
      ],
    };
    if (cash)
      payload.cash = {
        session_id: session,
        opening_event_id: opening.event_id,
        movement_id: randomUUID(),
      };
    return push('venta_confirmada', 'sale', saleId, payload);
  }
  const cashSale = await sale('cash', false, false, true),
    creditSale = await sale('credit'),
    secondCredit = await sale('credit'),
    measuredSale = await sale('cash', true),
    recipeSale = await sale('transfer', false, true);
  function adjustment(
    s: any,
    quantity: number,
    revision = 0,
    previous: any = null,
    amount?: number,
    restore = true,
  ) {
    const line = s.payload.lines[0],
      originalQ =
        line.snapshot.quantity ?? line.snapshot.measured_quantity_atomic;
    const amountMinor =
      amount ??
      SaleAdjustmentRules.cumulative(
        s.payload.total_minor,
        quantity,
        originalQ,
      );
    const cost =
      line.snapshot.standard_cost_minor_snapshot === null
        ? null
        : SaleAdjustmentRules.cumulative(
            line.snapshot.standard_cost_minor_snapshot *
              (line.snapshot.quantity ?? 1),
            quantity,
            originalQ,
          );
    const p: any = {
      schema_version: 1,
      kind: 'return',
      operation_id: randomUUID(),
      event_id: randomUUID(),
      sale_id: s.aggregate_id,
      confirmation_event_id: s.event_id,
      expected_revision: revision,
      previous_adjustment_event_id: previous?.event_id ?? null,
      occurred_at_ms: clock + 1000,
      utc_offset_minutes: 0,
      business_date: new Date(clock + 1000).toISOString().slice(0, 10),
      reason: 'Devolución original',
      currency: 'MXN',
      total_minor: amountMinor,
      settlement: {
        method: s.payload.payment_method,
        payment_id: s.payload.payment_id,
        cliente_id: s.payload.cliente_id,
        action:
          s.payload.payment_method === 'credit'
            ? 'credit_reduction'
            : 'refund_completed',
        reference:
          s.payload.payment_method === 'transfer' ? 'fixture-refund' : null,
        cash_enabled: false,
        cash: null,
      },
      lines: [
        {
          sale_item_id: line.sale_item_id,
          quantity_atomic: quantity,
          destination: restore ? 'restock' : 'not_restockable',
          reason: restore ? null : 'No recuperable',
          amount_minor: amountMinor,
          recovered_cost_minor: restore ? cost : 0,
          stock: restore
            ? [
                {
                  movement_id: randomUUID(),
                  original_movement_id: line.consumptions[0].movement_id,
                  inventory_item_id: line.consumptions[0].inventory_item_id,
                  quantity_atomic: quantity,
                },
              ]
            : [],
        },
      ],
      dependency_event_ids: [
        s.event_id,
        ...(previous ? [previous.event_id] : []),
      ],
    };
    return p;
  }
  const returned = adjustment(creditSale, 1),
    firstReturn = await push(
      'devolucion_venta_registrada',
      'sale',
      creditSale.aggregate_id,
      returned,
      1,
      creditSale.sequence,
    );
  await push('abono_cliente_registrado', 'customer_payment', randomUUID(), {
    cliente_id: customer,
    cliente_event_id: client.event_id,
    amount_minor: 1500,
    method: 'transfer',
    reference: null,
    currency: 'MXN',
    occurred_at_ms: clock + 1000,
  });
  const measuredReturn = adjustment(measuredSale, 1, 0, null, 33);
  measuredReturn.lines[0].recovered_cost_minor = 17;
  await push(
    'devolucion_venta_registrada',
    'sale',
    measuredSale.aggregate_id,
    measuredReturn,
    1,
    measuredSale.sequence,
  );
  // New conflicting intention, fully typed and original. Its physical evidence
  // is explicitly recognized, not inserted as a second official return.
  const losing = adjustment(creditSale, 1),
    loser = await push(
      'devolucion_venta_registrada',
      'sale',
      creditSale.aggregate_id,
      losing,
      1,
      creditSale.sequence,
      'conflict',
    );
  const preserved = saleReconciliationEvidence(
    parseSaleAdjustmentPayload(losing),
  );
  const recovery = preserved.map((x) => ({
    ...x,
    effect_id: randomUUID(),
    delta: x.ledger === 'credit' ? -200 : -x.delta,
    occurred_at_ms: clock + 1000,
    business_date: new Date(clock + 1000).toISOString().slice(0, 10),
  }));
  const reconciliationId = randomUUID(),
    reconciliationEvent = randomUUID();
  await push(
    'operacion_venta_conciliada',
    'sale',
    creditSale.aggregate_id,
    {
      schema_version: 1,
      operation_id: reconciliationId,
      event_id: reconciliationEvent,
      incident_id: loser.event_id,
      sale_id: creditSale.aggregate_id,
      loser_event_id: loser.event_id,
      winner_event_id: firstReturn.event_id,
      official_base_event_id: firstReturn.event_id,
      expected_revision: 1,
      occurred_at_ms: clock + 1000,
      reason: 'Reconocimiento original sintético',
      preserved_effects: preserved,
      recovery_effects: recovery,
      utc_offset_minutes: 0,
      business_date: new Date(clock + 1000).toISOString().slice(0, 10),
    },
    2,
    firstReturn.sequence,
  );
  const cashReturnPayload = adjustment(cashSale, 1);
  cashReturnPayload.settlement.cash_enabled = true;
  cashReturnPayload.settlement.cash = {
    session_id: session,
    opening_event_id: opening.event_id,
    movement_id: randomUUID(),
  };
  cashReturnPayload.dependency_event_ids.push(opening.event_id);
  const cashReturn = await push(
    'devolucion_venta_registrada',
    'sale',
    cashSale.aggregate_id,
    cashReturnPayload,
    1,
    cashSale.sequence,
  );
  const cashLosing = adjustment(cashSale, 1);
  cashLosing.settlement.cash_enabled = true;
  cashLosing.settlement.cash = {
    session_id: session,
    opening_event_id: opening.event_id,
    movement_id: randomUUID(),
  };
  cashLosing.dependency_event_ids.push(opening.event_id);
  const cashLoser = await push(
    'devolucion_venta_registrada',
    'sale',
    cashSale.aggregate_id,
    cashLosing,
    1,
    cashSale.sequence,
    'conflict',
  );
  const cashPreserved = saleReconciliationEvidence(
    parseSaleAdjustmentPayload(cashLosing),
  );
  const cashRecovery = cashPreserved.map((x) => ({
    ...x,
    effect_id: randomUUID(),
    delta: x.ledger === 'cash' ? 200 : -x.delta,
    occurred_at_ms: clock + 1000,
    business_date: new Date(clock + 1000).toISOString().slice(0, 10),
  }));
  await push(
    'operacion_venta_conciliada',
    'sale',
    cashSale.aggregate_id,
    {
      schema_version: 1,
      operation_id: randomUUID(),
      event_id: randomUUID(),
      incident_id: cashLoser.event_id,
      sale_id: cashSale.aggregate_id,
      loser_event_id: cashLoser.event_id,
      winner_event_id: cashReturn.event_id,
      official_base_event_id: cashReturn.event_id,
      expected_revision: 1,
      occurred_at_ms: clock + 1000,
      reason: 'Efectivo original preservado y recuperación documentada',
      preserved_effects: cashPreserved,
      recovery_effects: cashRecovery,
      utc_offset_minutes: 0,
      business_date: new Date(clock + 1000).toISOString().slice(0, 10),
    },
    2,
    cashReturn.sequence,
  );
  const financialCategory = randomUUID(),
    financial = await push(
      'categoria_financiera_creada',
      'financial_category',
      financialCategory,
      { name: 'Gasto documentado', direction: 'out', nature: 'operating' },
    );
  await push(
    'movimiento_financiero_registrado',
    'financial_entry',
    randomUUID(),
    {
      category_id: financialCategory,
      category_event_id: financial.event_id,
      category_name_snapshot: 'Gasto documentado',
      direction: 'out',
      nature: 'operating',
      amount_minor: 50,
      currency: 'MXN',
      method: 'cash',
      occurred_at_ms: clock + 1000,
      notes: null,
      reference: null,
      cash: {
        session_id: session,
        opening_event_id: opening.event_id,
        movement_id: randomUUID(),
      },
    },
  );
  const baselineAt = clock;
  await push(
    'saldo_cuenta_inicial_declarado',
    'account_balance_baseline',
    randomUUID(),
    { amount_minor: -1000, as_of_ms: baselineAt },
  );
  await push(
    'movimiento_financiero_registrado',
    'financial_entry',
    randomUUID(),
    {
      category_id: financialCategory,
      category_event_id: financial.event_id,
      category_name_snapshot: 'Gasto documentado',
      direction: 'out',
      nature: 'operating',
      amount_minor: 200,
      currency: 'MXN',
      method: 'transfer',
      occurred_at_ms: clock + 1000,
      notes: null,
      reference: 'after-baseline',
    },
  );
  const cashRows = await db.query(
    'SELECT * FROM cash_movements WHERE session_id=$1',
    [session],
  );
  const evidence = cashRows.map((v) =>
    CashMovementEvidence.fromJson({
      movement_id: v.id,
      event_id: v.created_event_id,
      direction: v.direction,
      amount_minor: Number(v.amount_minor),
      source_type: v.sale_payment_id
        ? 'sale_payment'
        : v.sale_adjustment_id
          ? 'sale_adjustment'
          : v.customer_payment_id
            ? 'customer_payment'
            : 'financial_entry',
      source_id:
        v.sale_payment_id ??
        v.sale_adjustment_id ??
        v.customer_payment_id ??
        v.financial_entry_id,
    }),
  );
  for (const row of await db.query(
    "SELECT r.*,e.payload->>'operation_id' operation_id FROM sale_reconciliation_effects r JOIN events e ON e.event_id=r.event_id WHERE r.ledger='cash' AND r.cash_session_id=$1",
    [session],
  )) {
    evidence.push(
      CashMovementEvidence.fromJson({
        movement_id: row.effect_id,
        event_id: row.event_id,
        direction: BigInt(row.delta) > 0n ? 'in' : 'out',
        amount_minor: Number(
          BigInt(row.delta) > 0n ? BigInt(row.delta) : -BigInt(row.delta),
        ),
        source_type: 'sale_reconciliation',
        source_id: row.operation_id,
      }),
    );
  }
  const income = evidence
      .filter((x) => x.direction === 'in')
      .reduce((n, x) => n + BigInt(x.amountMinor), 0n),
    expense = evidence
      .filter((x) => x.direction === 'out')
      .reduce((n, x) => n + BigInt(x.amountMinor), 0n),
    expected = 100n + income - expense;
  await push('caja_cerrada', 'cash_session', session, {
    opening_event_id: opening.event_id,
    closed_at_ms: clock + 1000,
    counted_minor: Number(expected),
    income_minor: String(income),
    expense_minor: String(expense),
    expected_minor: String(expected),
    difference_minor: '0',
    notes: null,
    movements: evidence.map((x) => x.toJson()),
  });
  // Catalogue mutations are authored after the commercial facts: old price,
  // category and resource identities must remain usable as historical evidence.
  await push('espacio_creado', 'espacio', randomUUID(), {
    nombre: 'Mesa recuperada',
    identificacion: 'M1',
    visibilidad: 'sin_restriccion',
  });
  await push(
    'proveedor_actualizado',
    'supplier',
    supplier,
    {
      base_event_id: supplied.event_id,
      before: supplied.payload,
      after: { name: 'Proveedor actual', phone: '123', notes: null },
    },
    1,
    supplied.sequence,
  );
  await push(
    'cliente_actualizado',
    'cliente',
    customer,
    {
      base_event_id: client.event_id,
      before: client.payload,
      after: { nombre: 'Cliente actual', telefono: '456' },
    },
    1,
    client.sequence,
  );
  const measuredAfter = JSON.parse(JSON.stringify(measuredConfig.payload));
  measuredAfter.product.name = 'Medido actual';
  await push(
    'producto_actualizado',
    'product',
    measuredProduct,
    {
      base_event_id: measuredConfig.event_id,
      before: measuredConfig.payload,
      after: measuredAfter,
    },
    1,
    measuredConfig.sequence,
  );
  const retiredResource = randomUUID(),
    retiredProduct = randomUUID(),
    retiredA = randomUUID(),
    retiredB = randomUUID();
  const retiredCreator = await push(
    'recurso_inventario_creado',
    'inventory_item',
    retiredResource,
    {
      inventory_item: {
        inventory_item_id: retiredResource,
        name: 'Recurso retirado',
        default_unit_id: piece.unit_id,
      },
      initial_movement: null,
    },
  );
  const retiredPayload = {
    product: {
      name: 'Producto retirado',
      category_id: null,
      sale_configuration: { mode: 'unit' },
    },
    variants: [
      {
        variant_id: retiredA,
        name: 'A',
        barcode: null,
        sale_price_minor: 100,
        standard_cost_minor: 50,
        minimum_stock_atomic: null,
        offer_price_minor: null,
        inventory_item_id: retiredResource,
        suppliers: [
          {
            supplier_id: supplier,
            quoted_price_minor: 20,
            quoted_at_ms: clock,
          },
        ],
        sort_order: 0,
      },
    ],
    dependencies: [
      { ref_type: 'inventory_item', ref_id: retiredResource },
      { ref_type: 'supplier', ref_id: supplier },
    ],
  };
  const retired = await push(
    'producto_creado',
    'product',
    retiredProduct,
    retiredPayload,
  );
  const removedAfter = JSON.parse(JSON.stringify(retired.payload));
  removedAfter.variants[0].variant_id = retiredB;
  removedAfter.variants[0].name = 'B';
  removedAfter.variants[0].inventory_item_id = null;
  removedAfter.dependencies = removedAfter.dependencies.filter(
    (d) => d.ref_type !== 'inventory_item',
  );
  const removed = await push(
    'producto_actualizado',
    'product',
    retiredProduct,
    {
      base_event_id: retired.event_id,
      before: retired.payload,
      after: removedAfter,
    },
    1,
    retired.sequence,
  );
  await push(
    'producto_actualizado',
    'product',
    retiredProduct,
    {
      base_event_id: removed.event_id,
      before: removedAfter,
      after: null,
      delete_product: true,
    },
    2,
    removed.sequence,
  );
  const independentRetired = randomUUID(),
    independentCreator = await push(
      'recurso_inventario_creado',
      'inventory_item',
      independentRetired,
      {
        inventory_item: {
          inventory_item_id: independentRetired,
          name: 'Independiente retirado',
          default_unit_id: piece.unit_id,
        },
        initial_movement: null,
      },
    );
  await push(
    'recurso_inventario_eliminado',
    'inventory_item',
    independentRetired,
    { base_event_id: independentCreator.event_id },
    1,
    independentCreator.sequence,
  );
  const nextCategory = randomUUID(),
    next = await push('categoria_creada', 'category', nextCategory, {
      name: 'Categoría conservada',
      color_key: 'green',
      sort_order: 1,
    });
  await push(
    'categoria_eliminada',
    'category',
    category,
    {
      base_event_id: cat.event_id,
      deleted_category: {
        name: 'Categoría original',
        color_key: 'blue',
        sort_order: 0,
        active: true,
        created_event_id: cat.event_id,
      },
      product_resolution: { type: 'uncategorize' },
      linked_products: [
        {
          product_id: product,
          base_event_id: configuration.event_id,
          base_version: 1,
          base_server_sequence: configuration.sequence,
          category_id: { from: category, to: null },
        },
      ],
      shifted_categories: [
        {
          category_id: nextCategory,
          base_event_id: next.event_id,
          base_version: 1,
          base_server_sequence: next.sequence,
          sort_order: { from: 1, to: 0 },
        },
      ],
    },
    1,
    cat.sequence,
  );
  for (let i = 0; i < extraSuppliers; i++) {
    await push('proveedor_creado', 'supplier', randomUUID(), {
      name: `S6 volume supplier ${i}`,
      phone: null,
      notes: null,
    });
  }
  const manifest = JSON.parse(JSON.stringify(sourceManifest));
  manifest.package_id = randomUUID();
  manifest.cut_at = new Date(clock + 1000).toISOString();
  manifest.source.device_id = device;
  manifest.checkpoint = {
    last_full_pull_sequence: null,
    last_full_pull_at: null,
  };
  manifest.chunks = [];
  const entities: Record<string, any[]> = {};
  for (const [table, columns] of Object.entries(RECOVERY_COLUMNS)) {
    const sql = Object.entries(columns)
      .map(([name, type]) =>
        type === 'bigint' || type === 'numeric'
          ? `"${name}"::text AS "${name}"`
          : type === 'timestamptz'
            ? `to_char("${name}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "${name}"`
            : `"${name}"`,
      )
      .join(',');
    const rows = await db.query(
      `SELECT ${sql} FROM "${table}"${table === 'event_refs' ? " WHERE event_id IN (SELECT event_id FROM events WHERE sync_status='synced')" : ''}`,
    );
    if (table === 'events')
      for (const r of rows) {
        r.local_sequence = null;
        r.updated_at_server = null;
      }
    if (table === 'event_refs') {
      for (const r of rows)
        r.event_ref_id = recoveryReferenceId([
          r.event_id,
          r.ref_type,
          r.ref_id,
          r.relationship,
        ]);
    }
    if (rows.length) entities[table] = rows;
  }
  const official = await db.query(
    'SELECT * FROM events ORDER BY server_sequence',
  );
  entities.event_provenance = official.map((e, i) => ({
    event_id: e.event_id,
    observed_local_sequence: String(i + 1),
    sequence_origin: 'sqlite_insertion_order',
    application_status: 'applied',
    delivery_status: e.sync_status === 'synced' ? 'delivered' : e.sync_status,
    non_official_evidence: null,
  }));
  entities.sale_presentation_metadata = (entities.sales ?? []).map((s) => ({
    sale_id: s.sale_id,
    created_at_local: s.created_at_local,
    updated_at_local: s.created_at_local,
    timestamp_origin: 'source_sqlite',
  }));
  manifest.baseline_high_watermark = String(
    Math.max(...official.map((e) => Number(e.server_sequence))),
  );
  const chunks: Buffer[] = [];
  for (const entity of Object.keys(entities).sort()) {
    const rows = [
      ...new Map(
        entities[entity].map((row) => [
          canonical(RECOVERY_KEYS[entity].map((k) => row[k])),
          row,
        ]),
      ).values(),
    ].sort((a, b) =>
      canonical(RECOVERY_KEYS[entity].map((k) => a[k])).localeCompare(
        canonical(RECOVERY_KEYS[entity].map((k) => b[k])),
      ),
    );
    for (let start = 0; start < rows.length; start += 1000) {
      const batch = rows.slice(start, start + 1000),
        index = chunks.length,
        bytes = Buffer.from(
          batch.map((row) => canonical({ entity, row })).join('\n') + '\n',
        );
      chunks.push(bytes);
      manifest.chunks.push({
        index,
        entity,
        file: String(index).padStart(6, '0') + '-' + entity + '.ndjson',
        rows: batch.length,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }
  return {
    manifest,
    chunks,
    ids: {
      customer,
      product,
      variant,
      resource,
      measuredResource,
      measuredProduct,
      measuredVariant,
      recipeProduct,
      recipeVariant,
      cashSale: cashSale.aggregate_id,
      creditSale: creditSale.aggregate_id,
      secondCredit: secondCredit.aggregate_id,
      measuredSale: measuredSale.aggregate_id,
      recipeSale: recipeSale.aggregate_id,
      session,
      baselineAt,
    },
    counts: Object.fromEntries(
      Object.entries(entities).map(([k, v]) => [k, v.length]),
    ),
  };
}
