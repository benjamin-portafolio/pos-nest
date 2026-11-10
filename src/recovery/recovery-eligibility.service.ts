import { Injectable } from '@nestjs/common';
import { EntityManager, TableColumn } from 'typeorm';
import { INVENTORY_UNIT_SEED } from '../inventory/inventory-unit-seed';
import {
  BUSINESS_TABLES,
  TECHNICAL_TABLES,
  SCHEMA_FINGERPRINT_SQL,
  ADMITTED_MIGRATIONS,
} from './recovery-schema';

@Injectable()
export class RecoveryEligibilityService {
  async inspect(m: EntityManager, state: any) {
    const tables: { tablename: string }[] = await m.query(
      "SELECT CASE WHEN schemaname=current_schema() THEN tablename ELSE schemaname||'.'||tablename END AS tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname !~ '^pg_toast' ORDER BY 1",
    );
    const unknown = tables
      .map((t) => t.tablename)
      .filter((t) => ![...BUSINESS_TABLES, ...TECHNICAL_TABLES].includes(t));
    const missing = BUSINESS_TABLES.filter(
      (t) => !tables.some((x) => x.tablename === t),
    );
    const counts: Record<string, number> = {};
    for (const table of BUSINESS_TABLES.filter((t) => !missing.includes(t))) {
      const [r] = await m.query(
        `SELECT count(*)::text AS count FROM "${table}"`,
      );
      counts[table] = Number(r.count);
    }
    const units = missing.includes('units')
      ? []
      : await m.query('SELECT * FROM units');
    const invalidUnits = units.filter(
      (u) =>
        !INVENTORY_UNIT_SEED.some(
          (s) =>
            u.unit_id === s.unitId &&
            u.code === s.code &&
            u.name === s.name &&
            u.symbol === s.symbol &&
            u.dimension === s.dimension &&
            String(u.atomic_factor) === String(s.atomicFactor) &&
            u.max_fraction_digits === s.maxFractionDigits &&
            u.active === true,
        ),
    );
    const physical: any[] = await m.query(
      `SELECT c.relname AS table_name,a.attname AS column_name,
      format_type(a.atttypid,a.atttypmod) AS column_type,a.attnotnull AS required,
      (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=a.atttypid) AS enum_values
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped`,
      [BUSINESS_TABLES],
    );
    const incompatibleColumns: string[] = [];
    for (const table of BUSINESS_TABLES) {
      const metadata = m.connection.entityMetadatas.find(
        (e) => e.tableName === table,
      );
      if (!metadata) {
        incompatibleColumns.push(table + ':missing_contract');
        continue;
      }
      const actual = physical.filter((c) => c.table_name === table);
      for (const column of metadata.columns) {
        const found = actual.find((c) => c.column_name === column.databaseName);
        const type = m.connection.driver.createFullType(
          new TableColumn({
            name: column.databaseName,
            type: m.connection.driver.normalizeType(column),
            length: column.length,
            precision: column.precision,
            scale: column.scale,
          }),
        );
        if (
          !found ||
          found.required === column.isNullable ||
          (column.enum
            ? JSON.stringify(found.enum_values) !== JSON.stringify(column.enum)
            : found.column_type !== type.toLowerCase())
        )
          incompatibleColumns.push(table + '.' + column.databaseName);
      }
      for (const column of actual)
        if (
          !metadata.columns.some((c) => c.databaseName === column.column_name)
        )
          incompatibleColumns.push(table + '.' + column.column_name);
    }
    const [fp] = await m.query(SCHEMA_FINGERPRINT_SQL, [BUSINESS_TABLES]);
    const reasons: string[] = [];
    if (tables.some((t) => t.tablename === 'migrations')) {
      const history = await m.query('SELECT name,timestamp FROM migrations');
      if (
        history.some(
          (r) =>
            !ADMITTED_MIGRATIONS.includes(r.name) ||
            !r.name.endsWith(String(r.timestamp)),
        )
      )
        reasons.push('incompatible_schema');
    }
    const [control] = await m.query(
      "SELECT (SELECT count(*) FROM sync_bindings)+(SELECT count(*) FROM recovery_sessions WHERE state='completed') AS occupied",
    );
    if (Number(control.occupied) > 0) reasons.push('destination_not_empty');
    if (
      unknown.length ||
      missing.length ||
      incompatibleColumns.length ||
      fp.fingerprint !== state.schema_fingerprint
    )
      reasons.push('incompatible_schema');
    if (
      invalidUnits.length ||
      Object.entries(counts).some(([t, c]) => t !== 'units' && c > 0) ||
      state.dataset_id
    )
      reasons.push('destination_not_empty');
    const [live] = await m.query(
      "SELECT count(*)::int AS count FROM recovery_sessions WHERE state IN ('receiving','validating','failed_validation','ready_to_commit')",
    );
    if (state.active_recovery_id || state.mode === 'recovering' || live.count)
      reasons.push('active_recovery');
    const [orphan] = await m.query(
      `SELECT count(*)::int AS count FROM recovery_chunks c JOIN recovery_sessions s USING(recovery_id) WHERE s.state<>'aborted'`,
    );
    if (orphan.count && !state.active_recovery_id)
      reasons.push('unpublished_staging');
    return {
      eligible: reasons.length === 0,
      reasons,
      counts,
      unknown_tables: unknown,
      missing_tables: missing,
      incompatible_columns: incompatibleColumns,
      invalid_unit_ids: invalidUnits.map((u) => u.unit_id),
      schema_fingerprint: fp.fingerprint,
      seed_units_present: units.length - invalidUnits.length,
    };
  }
}
