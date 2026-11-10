/** Closed inventory from S1. Unknown tables fail eligibility rather than disappear. */
export const BUSINESS_TABLES = [
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
  'sync_conflict_participants',
  'sync_conflicts',
  'units',
  'variant_inventory_memory',
  'variant_suppliers',
] as const;
export const TECHNICAL_TABLES = [
  'recovery_rows',
  'recovery_datasets',
  'recovery_dataset_chunks',
  'recovery_bootstrap_grants',
  'migrations',
  'server_state',
  'recovery_sessions',
  'recovery_chunks',
  'recovery_authorizations',
  'recovery_audit',
  'sync_bindings',
];
// Include physical columns, constraints, indexes and the installed gate triggers.
export const SCHEMA_FINGERPRINT_SQL = `SELECT encode(sha256(convert_to(string_agg(definition, E'\\n' ORDER BY definition),'UTF8')),'hex') AS fingerprint FROM (
 SELECT 'column:'||c.relname||':'||a.attnum||':'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS definition
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'constraint:'||c.relname||':'||pg_get_constraintdef(x.oid) FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1)
 UNION ALL SELECT 'index:'||tablename||':'||indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename=ANY($1)
 UNION ALL SELECT 'trigger:'||c.relname||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND NOT t.tgisinternal
 UNION ALL SELECT DISTINCT 'trigger-function:'||pg_get_functiondef(t.tgfoid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND NOT t.tgisinternal
) s`;

export const ADMITTED_MIGRATIONS = [
  'CreateSyncConflicts1783382400000',
  'CreateInventoryResources1787140800000',
  'AddProductSaleConfiguration1787227200000',
  'RemoveVariantInventoryConfiguration1787313600000',
  'AddAdvancedProductVariants1787400000000',
  'AddDirectVariantInventoryTracking1787745600000',
  'UpdateInventoryMovementFlow1788177600000',
  'CreateRecipeComponents1788264000000',
  'AddActiveVariantUniqueness1788912000000',
  'RemoveVariantDefault1788998400000',
  'AddCashSales1789516800000',
  'CreateClientes1789646400000',
  'AddCustomerCredit1790035200000',
  'AddTransferSales1790208000000',
  'CreateFinancialCategoriesAndEntries1790251200000',
  'CreateCashSessions1790337600000',
  'CreateAccountBalanceBaselines1790424000000',
  'AddVariantBarcode1790683200000',
  'AddInventoryOriginAndVariantMemory1790774400000',
  'ReconstructLegacyVariantInventoryMemory1790860800000',
  'CreateProductSuppliers1791417600000',
  'AddVariantMinimumStock1792368000000',
  'CreateSaleAdjustments1793145600000',
  'CreateSaleReconciliationEffects1793232000000',
  'AlignSaleAdjustmentProjectionComments1793318400000',
  'AddOfferPricing1793404800000',
  'CreateRecoveryProtocol1794096000000',
  'CreateRecoveryDataset1794182400000',
];

/** Transport only: unavailable remote conflict history cannot be recreated from local rows.
 * Sidecars preserve the evidence explicitly required in S1; S4 validates their typed rows.
 */
export const RECOVERY_ENTITIES: readonly string[] = [
  ...BUSINESS_TABLES.filter(
    (t) => t !== 'sync_conflicts' && t !== 'sync_conflict_participants',
  ),
  'inventory_item_discards',
  'sale_delivery_incidents',
  'sale_adjustment_evidence',
  'sale_presentation_metadata',
  // S3: observed local ordering and non-official evidence are not EventEntity.
  'event_provenance',
  'projection_provenance',
];
