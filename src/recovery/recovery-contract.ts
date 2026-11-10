import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { RECOVERY_ENTITIES } from './recovery-schema';
import { recoveryError } from './recovery-errors';
export const RECOVERY_LIMITS = {
  manifest_bytes: 16777216,
  chunk_bytes: 4194304,
  chunk_rows: 1000,
  chunks: 100000,
  total_bytes: 107374182400,
  progress_page: 500,
} as const;
export const sha256 = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export function canonical(value: any): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  )
    return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return recoveryError(400, 'invalid_canonical_json');
}
export function parseCanonical(bytes: Buffer): any {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (canonical(value) !== text) recoveryError(400, 'noncanonical_json');
    return value;
  } catch (e) {
    if (e?.getStatus) throw e;
    return recoveryError(400, 'invalid_json');
  }
}
function keys(value: any, expected: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !expected.includes(k)) ||
    expected.some((k) => !(k in value))
  )
    recoveryError(400, 'invalid_manifest_fields');
}
function decimal(v: unknown) {
  return (
    typeof v === 'string' &&
    /^(0|[1-9][0-9]*)$/.test(v) &&
    BigInt(v) <= 9007199254740991n
  );
}
function iso(v: unknown) {
  try {
    return (
      typeof v === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
      new Date(v).toISOString() === v
    );
  } catch {
    return false;
  }
}
export interface RecoveryChunk {
  index: number;
  entity: string;
  file: string;
  rows: number;
  bytes: number;
  sha256: string;
}
export interface RecoveryManifest {
  package_id: string;
  source: {
    device_id: string;
    schema_version: number;
    schema_fingerprint: string;
  };
  chunks: RecoveryChunk[];
  [key: string]: any;
}
export function parseManifest(bytes: Buffer): RecoveryManifest {
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > RECOVERY_LIMITS.manifest_bytes
  )
    recoveryError(413, 'manifest_size');
  const v = parseCanonical(bytes);
  keys(v, [
    'format',
    'package_id',
    'cut_at',
    'source',
    'checkpoint',
    'baseline_high_watermark',
    'contracts',
    'eligibility',
    'coverage',
    'exclusions',
    'chunks',
  ]);
  if (v.format !== 'pos-server-recovery/1')
    recoveryError(412, 'incompatible_contract');
  keys(v.source, [
    'mode',
    'device_id',
    'server_instance_id',
    'generation_id',
    'identity_provenance',
    'schema_version',
    'schema_fingerprint',
    'app_revision',
  ]);
  keys(v.checkpoint, ['last_full_pull_sequence', 'last_full_pull_at']);
  keys(v.contracts, ['recovery', 'bootstrap', 'sale_adjustments', 'pricing']);
  keys(v.eligibility, ['pending', 'failed', 'unresolved_incidents']);
  keys(v.coverage, ['global_completeness', 'dependency_closure']);
  if (
    !isUuid(v.package_id) ||
    !iso(v.cut_at) ||
    v.source.mode !== 'server_sync' ||
    typeof v.source.device_id !== 'string' ||
    !v.source.device_id.trim() ||
    v.source.device_id.length > 120 ||
    !Number.isSafeInteger(v.source.schema_version) ||
    v.source.schema_version < 1 ||
    !/^[0-9a-f]{64}$/.test(v.source.schema_fingerprint) ||
    typeof v.source.app_revision !== 'string' ||
    !v.source.app_revision ||
    !['legacy_unknown', 'known'].includes(v.source.identity_provenance) ||
    (v.source.identity_provenance === 'legacy_unknown'
      ? v.source.server_instance_id !== null || v.source.generation_id !== null
      : !isUuid(v.source.server_instance_id) ||
        !isUuid(v.source.generation_id)) ||
    (v.checkpoint.last_full_pull_sequence !== null &&
      !decimal(v.checkpoint.last_full_pull_sequence)) ||
    (v.checkpoint.last_full_pull_at !== null &&
      !iso(v.checkpoint.last_full_pull_at)) ||
    (v.checkpoint.last_full_pull_sequence === null &&
      v.checkpoint.last_full_pull_at !== null) ||
    !decimal(v.baseline_high_watermark) ||
    (v.checkpoint.last_full_pull_sequence !== null &&
      BigInt(v.baseline_high_watermark) <
        BigInt(v.checkpoint.last_full_pull_sequence)) ||
    !Object.values(v.eligibility).every(
      (x) => Number.isSafeInteger(x) && Number(x) >= 0,
    ) ||
    !['unknown', 'known_incomplete'].includes(v.coverage.global_completeness) ||
    !['validated', 'unchecked'].includes(v.coverage.dependency_closure) ||
    !Array.isArray(v.exclusions) ||
    !Array.isArray(v.chunks)
  )
    recoveryError(400, 'invalid_manifest');
  if (
    v.contracts.recovery !== 1 ||
    v.contracts.bootstrap !== 1 ||
    v.contracts.sale_adjustments !== 1 ||
    canonical(v.contracts.pricing) !== '[1,2]'
  )
    recoveryError(412, 'incompatible_contract');
  // Receiving authenticates transport, never attests business eligibility/closure.
  for (const x of v.exclusions) {
    keys(x, ['entity', 'count', 'reason']);
    if (
      !['drafts', 'quotations', 'preferences', 'local_journals'].includes(
        x.entity,
      ) ||
      !Number.isSafeInteger(x.count) ||
      x.count < 0 ||
      typeof x.reason !== 'string'
    )
      recoveryError(400, 'invalid_exclusion');
  }
  let total = 0;
  if (v.chunks.length > RECOVERY_LIMITS.chunks)
    recoveryError(413, 'chunk_count');
  for (const [index, c] of v.chunks.entries()) {
    keys(c, ['index', 'entity', 'file', 'rows', 'bytes', 'sha256']);
    if (
      c.index !== index ||
      !RECOVERY_ENTITIES.includes(c.entity) ||
      c.file !== `${String(index).padStart(6, '0')}-${c.entity}.ndjson` ||
      !Number.isInteger(c.rows) ||
      c.rows < 1 ||
      c.rows > RECOVERY_LIMITS.chunk_rows ||
      !Number.isInteger(c.bytes) ||
      c.bytes < 1 ||
      c.bytes > RECOVERY_LIMITS.chunk_bytes ||
      !/^[0-9a-f]{64}$/.test(c.sha256)
    )
      recoveryError(400, 'invalid_chunk_descriptor');
    total += c.bytes;
  }
  if (total > RECOVERY_LIMITS.total_bytes) recoveryError(413, 'package_size');
  return v;
}
export function validateChunk(bytes: Buffer, descriptor: RecoveryChunk): void {
  if (!Buffer.isBuffer(bytes) || bytes.length > RECOVERY_LIMITS.chunk_bytes)
    recoveryError(413, 'chunk_size');
  if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256)
    recoveryError(422, 'chunk_integrity');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return recoveryError(400, 'invalid_utf8');
  }
  if (!text.endsWith('\n')) recoveryError(400, 'ndjson_requires_lf');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length !== descriptor.rows) recoveryError(422, 'chunk_rows');
  const seen = new Set<string>();
  for (const line of lines) {
    const v = parseCanonical(Buffer.from(line));
    keys(v, ['entity', 'row']);
    if (
      v.entity !== descriptor.entity ||
      !v.row ||
      typeof v.row !== 'object' ||
      Array.isArray(v.row) ||
      !Object.keys(v.row).length
    )
      recoveryError(400, 'invalid_chunk_row');
    if (seen.has(line)) recoveryError(422, 'duplicate_chunk_row');
    seen.add(line);
  }
  // Typed fields, cross-chunk primary keys and business invariants belong to S4.
}
/** S4 requests: no success endpoint is exposed until a real engine exists. */
export interface RecoveryValidationRequest {
  protocol_version: 1;
  manifest_digest: string;
  expected_revision: number;
}
export interface RecoveryFinalizationRequest {
  protocol_version: 1;
  validation_digest: string;
  expected_revision: number;
}
