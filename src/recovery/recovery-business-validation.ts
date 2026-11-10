import { EntityManager } from 'typeorm';
import { canonical } from './recovery-contract';
import { recoveryError } from './recovery-errors';

export function recoveryAssert(
  ok: unknown,
  entity: string,
  id: string,
  rule: string,
): asserts ok {
  if (!ok) recoveryError(422, 'business_invariant', { entity, id, rule });
}
export function recoveryCompare(
  row: any,
  expected: Record<string, unknown>,
  entity: string,
  id: string,
) {
  recoveryAssert(row, entity, id, 'missing_projection');
  for (const [field, value] of Object.entries(expected))
    if (canonical(row[field]) !== canonical(value))
      recoveryError(422, 'business_invariant', {
        entity,
        id,
        field,
        expected: value,
        actual: row[field],
      });
}
export async function recoveryEvent(
  m: EntityManager,
  id: string,
  before?: any,
  status = 'synced',
) {
  const [e] = await m.query('SELECT * FROM events WHERE event_id=$1', [id]);
  recoveryAssert(
    e &&
      e.sync_status === status &&
      (!before || BigInt(e.server_sequence) < BigInt(before.server_sequence)),
    'events',
    id,
    'dependency_missing',
  );
  return e;
}
export function recoveryMetadata(
  e: any,
  version = 1,
  creator = e.event_id,
  active = true,
) {
  return {
    active,
    version,
    created_event_id: creator,
    last_event_id: e.event_id,
    last_server_sequence: String(e.server_sequence),
  };
}
/** Cursor is sequence, not OFFSET; memory bounded even for one busy aggregate. */
export async function* recoveryHistory(
  m: EntityManager,
  predicate: string,
  values: unknown[],
): AsyncGenerator<any> {
  let cursor = '0';
  for (;;) {
    const page = await m.query(
      `SELECT * FROM events WHERE sync_status='synced' AND (${predicate}) AND server_sequence>$${values.length + 1} ORDER BY server_sequence LIMIT 200`,
      [...values, cursor],
    );
    if (!page.length) return;
    for (const e of page) {
      cursor = e.server_sequence;
      yield e;
    }
  }
}
