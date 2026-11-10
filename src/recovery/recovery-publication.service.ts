import { CustomerCreditProjector } from '../sync/customer-credit.projector';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { canonical, sha256, RECOVERY_LIMITS } from './recovery-contract';
import { RECOVERY_COLUMNS } from './recovery-logical-schema';
import { recoveryError } from './recovery-errors';
import {
  recoveryEventReferences,
  recoveryReferenceId,
  recoveryReferenceContext,
} from './recovery-event-references';
import { RecoveryValidationService } from './recovery-validation.service';

/** Caller holds server_state FOR UPDATE. No handlers, notifications or external I/O. */
@Injectable()
export class RecoveryPublicationService {
  constructor(private readonly validation: RecoveryValidationService) {}
  async materialize(
    m: EntityManager,
    id: string,
    manifest: any,
    importedAt: string,
  ) {
    // This mode change is uncommitted. Other writers/readers wait on the singleton,
    // and see recovering again on rollback. The SQL trigger is never disabled.
    await this.sequence(m);
    await m.query("UPDATE server_state SET mode='active' WHERE singleton");
    const order = [
      'events',
      'units',
      'suppliers',
      'clientes',
      'categories',
      'espacios',
      'inventory_items',
      'products',
      'product_variants',
      'recipe_components',
      'variant_suppliers',
      'variant_inventory_memory',
      'sales',
      'sale_items',
      'sale_payments',
      'credit_sales',
      'customer_payments',
      'financial_categories',
      'financial_entries',
      'account_balance_baselines',
      'cash_sessions',
      'sale_adjustments',
      'sale_adjustment_lines',
      'sale_credit_reductions',
      'inventory_movements',
      'inventory_balances',
      'sale_reconciliation_effects',
      'cash_movements',
      'credit_allocations',
    ];
    for (const entity of order) {
      const columns = Object.keys(RECOVERY_COLUMNS[entity]);
      const timestamps =
        entity === 'events'
          ? []
          : ['created_at_server', 'updated_at_server'].filter((c) =>
              Object.hasOwn(RECOVERY_COLUMNS[entity], 'created_event_id'),
            );
      const all = [...columns, ...timestamps];
      const select = columns
        .map((c) =>
          entity === 'events' && c === 'updated_at_server'
            ? `coalesce(r."${c}",$3::timestamptz)`
            : `r."${c}"`,
        )
        .concat(timestamps.map(() => '$3::timestamptz'));
      // Identifiers come solely from the reviewed closed schema above.
      await m.query(
        `INSERT INTO "${entity}" (${all.map((c) => '"' + c + '"').join(',')}) SELECT ${select.join(',')} FROM recovery_rows s CROSS JOIN LATERAL jsonb_populate_record(NULL::"${entity}",s.row_data) r WHERE s.recovery_id=$1 AND s.entity=$2 ORDER BY s.row_key ${entity === 'units' ? 'ON CONFLICT(unit_id) DO NOTHING' : ''}`,
        timestamps.length || entity === 'events'
          ? [id, entity, importedAt]
          : [id, entity],
      );
    }
    const [badNet] = await m.query(
      'SELECT c.id FROM credit_sales c LEFT JOIN sale_credit_reductions r ON r.credit_id=c.id GROUP BY c.id HAVING sum(r.amount_minor)>c.amount_minor LIMIT 1',
    );
    if (badNet)
      recoveryError(422, 'excessive_credit_reduction', {
        credit_id: badNet.id,
      });
    let customerAfter = '';
    for (;;) {
      const customers = await m.query(
        'SELECT cliente_id FROM clientes WHERE cliente_id::text>$1 ORDER BY cliente_id LIMIT 200',
        [customerAfter],
      );
      if (!customers.length) break;
      for (const customer of customers) {
        customerAfter = customer.cliente_id;
        await new CustomerCreditProjector().rebuild(m, customerAfter);
      }
    }
    // References form a deterministic set. Do not accept extra semantic refs.
    let refAfter = '';
    for (;;) {
      const suppliedRefs = await m.query(
        "SELECT row_data FROM recovery_rows WHERE recovery_id=$1 AND entity='event_refs' AND row_key>$2 ORDER BY row_key LIMIT 500",
        [id, refAfter],
      );
      if (!suppliedRefs.length) break;
      for (const { row_data: r } of suppliedRefs) {
        refAfter = canonical([r.event_ref_id]);
        if (
          r.event_ref_id !==
          recoveryReferenceId([
            r.event_id,
            r.ref_type,
            r.ref_id,
            r.relationship,
          ])
        )
          recoveryError(422, 'invalid_reference_identity');
      }
    }
    await m.query(
      `INSERT INTO event_refs SELECT r.* FROM recovery_rows s CROSS JOIN LATERAL jsonb_populate_record(NULL::event_refs,s.row_data) r WHERE s.recovery_id=$1 AND s.entity='event_refs'`,
      [id],
    );
    let cursor = '';
    for (;;) {
      const events = await m.query(
        "SELECT * FROM events WHERE event_id::text>$1 AND sync_status='synced' ORDER BY event_id LIMIT 500",
        [cursor],
      );
      if (!events.length) break;
      for (const e of events) {
        cursor = e.event_id;
        for (const ref of recoveryEventReferences(
          e,
          await recoveryReferenceContext(m, e),
        )) {
          await m.query(
            'INSERT INTO event_refs SELECT r.* FROM jsonb_populate_record(NULL::event_refs,$1) r ON CONFLICT(event_ref_id) DO NOTHING',
            [ref],
          );
          await m.query(
            "INSERT INTO recovery_rows VALUES($1,'event_refs',$2,$3) ON CONFLICT(recovery_id,entity,row_key) DO NOTHING",
            [id, canonical([ref.event_ref_id]), ref],
          );
        }
      }
    }
    // Ensure non-business extras cannot disappear during materialization.
    const summary = await this.validation.check(m, {
      ...manifest,
      recovery_id: id,
    });
    return summary;
  }
  async dataset(
    m: EntityManager,
    id: string,
    manifest: any,
    summary: any,
    importedAt: string,
  ) {
    const datasetId = randomUUID();
    // The artifact lives in PG and commits with the business. Streaming downloads
    // never paginate live projections, even when new operations arrive later.
    const chunks: any[] = [];
    await m.query(
      'INSERT INTO recovery_datasets(dataset_id,recovery_id,generation_id,manifest_bytes,digest,summary,imported_at) SELECT $1,$2,candidate_generation_id,$3,$4,$5,$6 FROM recovery_sessions WHERE recovery_id=$2',
      [datasetId, id, Buffer.from('{}'), '0'.repeat(64), summary, importedAt],
    );
    let entityAfter = '',
      keyAfter = '',
      buffer: Buffer[] = [],
      size = 0,
      entity = '',
      totalBytes = 0;
    const flush = async () => {
      if (!buffer.length) return;
      const content = Buffer.concat(buffer),
        index = chunks.length;
      totalBytes += content.length;
      if (
        index >= RECOVERY_LIMITS.chunks ||
        totalBytes > RECOVERY_LIMITS.total_bytes
      )
        recoveryError(413, 'bootstrap_size');
      chunks.push({
        index,
        entity,
        rows: buffer.length,
        bytes: content.length,
        sha256: sha256(content),
      });
      await m.query('INSERT INTO recovery_dataset_chunks VALUES($1,$2,$3)', [
        datasetId,
        index,
        content,
      ]);
      buffer = [];
      size = 0;
    };
    for (;;) {
      const rows = await m.query(
        'SELECT entity,row_key,row_data FROM recovery_rows WHERE recovery_id=$1 AND (entity,row_key)>($2,$3) ORDER BY entity,row_key LIMIT 500',
        [id, entityAfter, keyAfter],
      );
      if (!rows.length) break;
      for (const r of rows) {
        const line = Buffer.from(
          canonical({ entity: r.entity, row: r.row_data }) + '\n',
        );
        if (line.length > RECOVERY_LIMITS.chunk_bytes)
          recoveryError(413, 'bootstrap_row_size');
        if (
          entity !== r.entity ||
          buffer.length >= RECOVERY_LIMITS.chunk_rows ||
          size + line.length > RECOVERY_LIMITS.chunk_bytes
        )
          await flush();
        entity = r.entity;
        buffer.push(line);
        size += line.length;
        entityAfter = r.entity;
        keyAfter = r.row_key;
      }
    }
    await flush();
    const [state] = await m.query('SELECT * FROM server_state WHERE singleton');
    const descriptor = {
      format: 'pos-baseline-bootstrap/1',
      bootstrap_version: 1,
      dataset_id: datasetId,
      server_instance_id: state.server_instance_id,
      generation_id: state.generation_id,
      baseline_high_watermark: manifest.baseline_high_watermark,
      source_manifest_digest: sha256(Buffer.from(canonical(manifest))),
      timestamp_origin: 'import',
      imported_at: importedAt,
      summary,
      chunks,
    };
    const bytes = Buffer.from(canonical(descriptor)),
      digest = sha256(bytes);
    if (bytes.length > RECOVERY_LIMITS.manifest_bytes)
      recoveryError(413, 'bootstrap_manifest_size');
    await m.query(
      'UPDATE recovery_datasets SET manifest_bytes=$2,digest=$3 WHERE dataset_id=$1',
      [datasetId, bytes, digest],
    );
    return { dataset_id: datasetId, bootstrap_digest: digest, descriptor };
  }
  private async sequence(m: EntityManager) {
    const [r] = await m.query(
      "SELECT pg_get_serial_sequence('events','server_sequence') AS name",
    );
    if (!r?.name) recoveryError(412, 'missing_event_sequence');
    // USAGE alone cannot setval. Migration operator grants UPDATE only on this
    // sequence to the runtime role; no ownership/DDL or general sequence privileges.
    const [v] = await m.query(
      `SELECT last_value::text AS value FROM ${r.name
        .split('.')
        .map((x: string) => '"' + x.replace(/"/g, '') + '"')
        .join('.')}`,
    );
    if (BigInt(v.value) >= 9007199254740991n)
      recoveryError(422, 'sequence_exhausted');
    return { name: r.name, value: v.value };
  }
  async advanceSequence(m: EntityManager, h: string) {
    const sequence = await this.sequence(m);
    const v = { value: sequence.value },
      r = { name: sequence.name };
    const next = BigInt(v.value) > BigInt(h) ? v.value : h;
    await m.query('SELECT setval($1::regclass,$2::bigint,true)', [
      r.name,
      next,
    ]);
  }
}
