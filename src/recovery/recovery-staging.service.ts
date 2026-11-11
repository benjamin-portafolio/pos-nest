import { RECOVERY_SIDECAR_COLUMNS } from './recovery-sidecar-schema';
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  parseManifest,
  sha256,
  validateChunk,
  canonical,
  isUuid,
} from './recovery-contract';
import { RECOVERY_COLUMNS, RECOVERY_KEYS } from './recovery-logical-schema';
import { recoveryError } from './recovery-errors';

const recognizedSourceV10Fingerprints = new Set([
  // Instalación creada con el esquema actual.
  'c5a129e2d98ad16a28983fe6b97e2d3e5facbce09e474e8cccc39693fc021254',
  // Instalación v8 reconocida, migrada por Flutter hasta v10.
  'ef3bd9c5f9c5388a4d620126231bf49dffa81f86967923df312d001196b911c9',
]);

/** Reads one transport chunk at a time; typed rows stay private and durable in PG. */
@Injectable()
export class RecoveryStagingService {
  async load(m: EntityManager, session: any) {
    if (sha256(session.manifest_bytes) !== session.manifest_digest)
      recoveryError(422, 'manifest_integrity');
    const manifest = parseManifest(session.manifest_bytes);
    if (Object.values(manifest.eligibility).some((v) => v !== 0))
      recoveryError(422, 'source_not_eligible');
    if (BigInt(manifest.baseline_high_watermark) >= 9007199254740991n)
      recoveryError(422, 'sequence_exhausted');
    // Exact physical signature produced and verified by S3, rather than accepting any version integer.
    if (
      manifest.source.schema_version !== 10 ||
      !recognizedSourceV10Fingerprints.has(manifest.source.schema_fingerprint)
    )
      recoveryError(412, 'incompatible_source_schema');
    const [count] = await m.query(
      'SELECT count(*)::int AS count FROM recovery_chunks WHERE recovery_id=$1',
      [session.recovery_id],
    );
    if (count.count !== manifest.chunks.length)
      recoveryError(422, 'incomplete_package');
    await m.query('DELETE FROM recovery_rows WHERE recovery_id=$1', [
      session.recovery_id,
    ]);
    const last = new Map<string, string>();
    const counts: Record<string, number> = {};
    for (const d of manifest.chunks) {
      const [chunk] = await m.query(
        'SELECT * FROM recovery_chunks WHERE recovery_id=$1 AND chunk_index=$2',
        [session.recovery_id, d.index],
      );
      if (!chunk || chunk.digest !== d.sha256 || chunk.row_count !== d.rows)
        recoveryError(422, 'incomplete_package');
      validateChunk(chunk.content, d);
      for (const line of chunk.content.toString('utf8').trimEnd().split('\n')) {
        const { row } = JSON.parse(line);
        this.row(d.entity, row);
        const key = canonical(RECOVERY_KEYS[d.entity].map((c) => row[c]));
        if (last.has(d.entity) && last.get(d.entity)! >= key)
          recoveryError(422, 'duplicate_or_unordered_key', {
            entity: d.entity,
            key,
          });
        last.set(d.entity, key);
        await m.query(
          'INSERT INTO recovery_rows(recovery_id,entity,row_key,row_data) VALUES($1,$2,$3,$4)',
          [session.recovery_id, d.entity, key, row],
        );
        counts[d.entity] = (counts[d.entity] ?? 0) + 1;
      }
    }
    return { manifest, counts };
  }
  row(entity: string, row: any) {
    for (const key of RECOVERY_KEYS[entity] ?? [])
      if (
        typeof row[key] !== 'string' ||
        (key !== 'entity' && !isUuid(row[key]))
      )
        recoveryError(422, 'invalid_primary_key', { entity, key });
    const columns =
      RECOVERY_COLUMNS[entity] ?? RECOVERY_SIDECAR_COLUMNS[entity];
    if (!columns) {
      // Complex physical reconciliation sidecars must have a semantic validator before activation.
      if (!['event_provenance', 'sale_presentation_metadata'].includes(entity))
        recoveryError(412, 'unsupported_recovery_sidecar', { entity });
      const fields =
        entity === 'event_provenance'
          ? [
              'event_id',
              'observed_local_sequence',
              'sequence_origin',
              'application_status',
              'delivery_status',
              'non_official_evidence',
            ]
          : [
              'sale_id',
              'created_at_local',
              'updated_at_local',
              'timestamp_origin',
            ];
      this.fields(entity, row, fields);
      if (
        entity === 'event_provenance' &&
        (row.sequence_origin !== 'sqlite_insertion_order' ||
          row.application_status !== 'applied' ||
          !['delivered', 'rejected', 'conflict'].includes(
            row.delivery_status,
          ) ||
          !this.decimal(row.observed_local_sequence) ||
          BigInt(row.observed_local_sequence) < 0n ||
          BigInt(row.observed_local_sequence) > 9007199254740991n)
      )
        recoveryError(422, 'invalid_event_provenance');
      if (
        entity === 'sale_presentation_metadata' &&
        (row.timestamp_origin !== 'source_sqlite' ||
          !this.iso(row.created_at_local) ||
          !this.iso(row.updated_at_local))
      )
        recoveryError(422, 'invalid_sale_metadata');
      return;
    }
    this.fields(entity, row, Object.keys(columns));
    for (const [key, type] of Object.entries(columns)) {
      const v = row[key];
      if (v === null) continue; // Nullability is enforced by actual PG constraints, not a guessed DTO default.
      let valid = false;
      switch (type) {
        case 'uuid':
          valid = isUuid(v);
          break;
        case 'boolean':
          valid = typeof v === 'boolean';
          break;
        case 'integer':
          valid = Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
          break;
        case 'bigint':
          valid =
            this.decimal(v) &&
            BigInt(v) >= -9007199254740991n &&
            BigInt(v) <= 9007199254740991n;
          break;
        case 'numeric':
          valid = this.decimal(v);
          break;
        case 'timestamptz':
          valid = this.iso(v);
          break;
        case 'jsonb':
          valid = typeof v === 'object' && v !== null;
          break;
        default:
          valid = typeof v === 'string';
      }
      if (!valid) recoveryError(422, 'invalid_typed_field', { entity, key });
      if (
        key.endsWith('server_sequence') ||
        key === 'server_sequence' ||
        key === 'source_server_sequence'
      )
        if (BigInt(v) < 0n) recoveryError(422, 'invalid_sequence');
    }
    if (
      entity === 'events' &&
      (row.local_sequence !== null ||
        !['synced', 'rejected', 'conflict'].includes(row.sync_status) ||
        row.server_sequence === null ||
        row.created_at_server === null)
    )
      recoveryError(422, 'unaccredited_event');
    if (
      entity === 'espacios' &&
      typeof row.identificacion === 'string' &&
      !row.identificacion.trim()
    )
      recoveryError(422, 'empty_space_identification');
  }
  private fields(entity: string, row: any, keys: string[]) {
    if (
      Object.keys(row).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(row, k))
    )
      recoveryError(422, 'invalid_row_columns', { entity });
  }
  private decimal(v: any): v is string {
    return (
      typeof v === 'string' && v.length <= 100 && /^(0|-?[1-9][0-9]*)$/.test(v)
    );
  }
  private iso(v: any) {
    try {
      return typeof v === 'string' && new Date(v).toISOString() === v;
    } catch {
      return false;
    }
  }
}
