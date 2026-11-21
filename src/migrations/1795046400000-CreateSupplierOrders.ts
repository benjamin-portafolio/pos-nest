import { SCHEMA_FINGERPRINT_SQL } from '../recovery/recovery-schema';
import { MigrationInterface, QueryRunner } from 'typeorm';
const BUSINESS_TABLES = [
  'account_balance_baselines',
  'cash_movements',
  'cash_sessions',
  'categories',
  'clientes',
  'credit_allocations',
  'credit_sales',
  'customer_payments',
  'espacios',
  'event_refs',
  'events',
  'financial_categories',
  'financial_entries',
  'inventory_balances',
  'inventory_items',
  'inventory_movements',
  'product_variants',
  'products',
  'recipe_components',
  'sale_adjustment_lines',
  'sale_adjustments',
  'sale_credit_reductions',
  'sale_items',
  'sale_payments',
  'sale_reconciliation_credit_allocations',
  'sale_reconciliation_effects',
  'sales',
  'suppliers',
  'supplier_orders',
  'supplier_order_items',
  'supplier_receipts',
  'supplier_receipt_items',
  'sync_conflict_participants',
  'sync_conflicts',
  'units',
  'variant_inventory_memory',
  'variant_suppliers',
] as const;

/** S1 aditiva. TypeORM ejecuta dentro de su transacción; no toca datos históricos. */
export class CreateSupplierOrders1795046400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    if (!q.isTransactionActive)
      throw new Error(
        'La migración requiere transacción; no se admite aplicación parcial',
      );
    // El esquema previo debe estar instalado; rechazo antes de cualquier ALTER.
    const [control] = await q.query(
      "SELECT to_regclass('server_state') IS NOT NULL AS installed",
    );
    if (control.installed) {
      const [state] = await q.query(
        'SELECT * FROM server_state WHERE singleton FOR UPDATE',
      );
      const [live] = await q.query(
        "SELECT EXISTS(SELECT 1 FROM recovery_sessions WHERE state IN ('receiving','validating','failed_validation','ready_to_commit')) AS present",
      );
      if (
        state.mode === 'recovering' ||
        state.active_recovery_id ||
        live.present
      )
        throw new Error(
          'Recuperación activa; conservar esquema y reintentar al terminar',
        );
    }
    await q.query(
      'ALTER TABLE product_variants ADD COLUMN current_supplier_id uuid, ADD COLUMN target_stock_atomic bigint CHECK (target_stock_atomic BETWEEN 0 AND 9007199254740991)',
    );
    await q.query(
      "CREATE TABLE supplier_orders (id uuid PRIMARY KEY, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_event_id uuid, last_event_id uuid, last_server_sequence bigint, created_at_server timestamptz(3) NOT NULL DEFAULT now(), updated_at_server timestamptz(3) NOT NULL DEFAULT now(), supplier_id uuid NOT NULL REFERENCES suppliers(supplier_id) ON DELETE RESTRICT, status text NOT NULL, occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms BETWEEN 1 AND 9007199254740991), currency text NOT NULL, supplier_name_snapshot text NOT NULL, supplier_phone_snapshot text, notes text, total_minor bigint CHECK (total_minor BETWEEN 0 AND 9007199254740991), CHECK (status IN ('draft','confirmed','partial','received','closed','cancelled')), CHECK (length(currency) = 3), CHECK (length(supplier_name_snapshot) BETWEEN 1 AND 160), CHECK (supplier_phone_snapshot IS NULL OR length(supplier_phone_snapshot) <= 80), CHECK (notes IS NULL OR length(notes) <= 1000))",
    );
    await q.query(
      'CREATE INDEX ix_supplier_orders_lookup ON supplier_orders (supplier_id, status, occurred_at_ms)',
    );
    await q.query(
      "CREATE TABLE supplier_order_items (id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES supplier_orders(id) ON DELETE RESTRICT, variant_id uuid NOT NULL REFERENCES product_variants(variant_id) ON DELETE RESTRICT, inventory_item_id uuid NOT NULL REFERENCES inventory_items(inventory_item_id) ON DELETE RESTRICT, unit_id uuid NOT NULL REFERENCES units(unit_id) ON DELETE RESTRICT, product_name_snapshot text NOT NULL, variant_name_snapshot text, dimension text NOT NULL, unit_code_snapshot text NOT NULL, unit_symbol_snapshot text NOT NULL, unit_atomic_factor bigint NOT NULL CHECK (unit_atomic_factor BETWEEN 1 AND 9007199254740991), reference_quantity_atomic bigint NOT NULL CHECK (reference_quantity_atomic BETWEEN 1 AND 9007199254740991), quantity_atomic bigint NOT NULL CHECK (quantity_atomic BETWEEN 1 AND 9007199254740991), quoted_price_minor bigint CHECK (quoted_price_minor BETWEEN 0 AND 9007199254740991), total_minor bigint CHECK (total_minor BETWEEN 0 AND 9007199254740991), closed_quantity_atomic bigint NOT NULL DEFAULT 0 CHECK (closed_quantity_atomic BETWEEN 0 AND 9007199254740991), position bigint NOT NULL, CHECK (dimension IN ('count','mass','volume')), CHECK (length(product_name_snapshot) BETWEEN 1 AND 160), CHECK (variant_name_snapshot IS NULL OR length(variant_name_snapshot) <= 160), CHECK (length(unit_code_snapshot) BETWEEN 1 AND 16), CHECK (length(unit_symbol_snapshot) BETWEEN 1 AND 16), CHECK (dimension <> 'count' OR (unit_atomic_factor = 1 AND reference_quantity_atomic = 1)), CHECK (closed_quantity_atomic <= quantity_atomic), CHECK (position BETWEEN 0 AND 49), UNIQUE (order_id, position), UNIQUE (order_id, variant_id), UNIQUE (order_id, id), CHECK ((quoted_price_minor IS NULL) = (total_minor IS NULL)))",
    );
    await q.query(
      'CREATE INDEX ix_supplier_order_items_lookup ON supplier_order_items (variant_id, order_id)',
    );
    await q.query(
      'CREATE TABLE supplier_receipts (id uuid PRIMARY KEY, active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1, created_event_id uuid, last_event_id uuid, last_server_sequence bigint, created_at_server timestamptz(3) NOT NULL DEFAULT now(), updated_at_server timestamptz(3) NOT NULL DEFAULT now(), order_id uuid NOT NULL REFERENCES supplier_orders(id) ON DELETE RESTRICT, event_id uuid NOT NULL, intent_hash text NOT NULL, base_event_id uuid NOT NULL, occurred_at_ms bigint NOT NULL CHECK (occurred_at_ms BETWEEN 1 AND 9007199254740991), total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 9007199254740991), UNIQUE (event_id), UNIQUE (order_id, id), CHECK (length(intent_hash) = 64))',
    );
    await q.query(
      'CREATE INDEX ix_supplier_receipts_lookup ON supplier_receipts (order_id, occurred_at_ms)',
    );
    await q.query(
      'CREATE TABLE supplier_receipt_items (id uuid PRIMARY KEY, receipt_id uuid NOT NULL REFERENCES supplier_receipts(id) ON DELETE RESTRICT, order_id uuid NOT NULL REFERENCES supplier_orders(id) ON DELETE RESTRICT, order_item_id uuid NOT NULL REFERENCES supplier_order_items(id) ON DELETE RESTRICT, quantity_atomic bigint NOT NULL CHECK (quantity_atomic BETWEEN 1 AND 9007199254740991), actual_price_minor bigint NOT NULL CHECK (actual_price_minor BETWEEN 0 AND 9007199254740991), total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 9007199254740991), movement_id uuid NOT NULL REFERENCES inventory_movements(movement_id) ON DELETE RESTRICT, UNIQUE (movement_id), UNIQUE (receipt_id, order_item_id), FOREIGN KEY (order_id, receipt_id) REFERENCES supplier_receipts(order_id, id) ON DELETE RESTRICT, FOREIGN KEY (order_id, order_item_id) REFERENCES supplier_order_items(order_id, id) ON DELETE RESTRICT)',
    );
    await q.query(
      'CREATE INDEX ix_supplier_receipt_items_lookup ON supplier_receipt_items (order_item_id, receipt_id)',
    );
    await q.query(
      "CREATE FUNCTION check_supplier_current() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN\nIF TG_TABLE_NAME = 'product_variants' THEN\n IF NEW.current_supplier_id IS NOT NULL THEN\n  PERFORM 1 FROM variant_suppliers WHERE variant_id=NEW.variant_id AND supplier_id=NEW.current_supplier_id FOR KEY SHARE;\n  IF NOT FOUND THEN RAISE EXCEPTION 'El proveedor actual debe estar asociado' USING ERRCODE='23503'; END IF;\n END IF;\n RETURN NEW;\nELSE\n IF TG_OP='UPDATE' AND NEW.variant_id=OLD.variant_id AND NEW.supplier_id=OLD.supplier_id THEN RETURN NEW; END IF;\n IF EXISTS (SELECT 1 FROM product_variants WHERE variant_id=OLD.variant_id AND current_supplier_id=OLD.supplier_id) THEN\n  RAISE EXCEPTION 'Retire o sustituya primero el proveedor actual' USING ERRCODE='23503';\n END IF;\n IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;\nEND IF; END $$",
    );
    await q.query(
      'CREATE TRIGGER supplier_current_write BEFORE INSERT OR UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION check_supplier_current()',
    );
    await q.query(
      'CREATE TRIGGER supplier_current_pair BEFORE DELETE OR UPDATE ON variant_suppliers FOR EACH ROW EXECUTE FUNCTION check_supplier_current()',
    );
    await q.query(
      'ALTER TABLE product_variants ADD CONSTRAINT fk_current_supplier_pair FOREIGN KEY (variant_id, current_supplier_id) REFERENCES variant_suppliers(variant_id, supplier_id) DEFERRABLE INITIALLY DEFERRED',
    );
    if (control.installed) {
      for (const table of [
        'supplier_orders',
        'supplier_order_items',
        'supplier_receipts',
        'supplier_receipt_items',
      ]) {
        await q.query(
          `CREATE TRIGGER recovery_business_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION recovery_business_gate()`,
        );
      }
      const [fp] = await q.query(SCHEMA_FINGERPRINT_SQL, [BUSINESS_TABLES]);
      await q.query(
        'UPDATE server_state SET schema_fingerprint=$1, revision=revision+1 WHERE singleton',
        [fp.fingerprint],
      );
    }
  }
  async down(): Promise<void> {
    throw new Error(
      'Downgrade destructivo no permitido; conservar pedidos y recepciones.',
    );
  }
}
