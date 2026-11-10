import {
  canonical,
  parseCanonical,
  parseManifest,
  sha256,
  validateChunk,
} from './recovery-contract';
import { RECOVERY_ENTITIES } from './recovery-schema';
describe('Recovery transport contract', () => {
  test.each([
    '{"b":1,"a":2}',
    '{"a":1,"a":1}',
    '{"x":1.5}',
    '{"x":9007199254740992}',
    '{"x":-0}',
    '{"x":1}\n',
  ])('rejects noncanonical, duplicate or unsafe JSON: %s', (value) => {
    expect(() => parseCanonical(Buffer.from(value))).toThrow();
  });
  test('canonical keys, Unicode, arrays and exact SHA256 bytes', () => {
    const value = { z: [1, null, true], a: 'Café' };
    expect(canonical(value)).toBe('{"a":"Café","z":[1,null,true]}');
    expect(parseCanonical(Buffer.from(canonical(value)))).toEqual(value);
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  test.each([
    Buffer.from('{"entity":"products","row":{"x":1}}'),
    Buffer.from('{"entity":"products","row":{}}\n'),
    Buffer.from('{"entity":"units","row":{"x":1}}\n'),
    Buffer.from('{"entity":"products","row":{"x":"\ufffd"}}\n').map((x, i) =>
      i === 33 ? 255 : x,
    ),
  ])('rejects malformed or mismatched chunk %p', (bytes) => {
    expect(() =>
      validateChunk(bytes, {
        index: 0,
        entity: 'products',
        file: '000000-products.ndjson',
        bytes: bytes.length,
        rows: 1,
        sha256: sha256(bytes),
      }),
    ).toThrow();
  });
  test('duplicate exact rows are rejected; typed/cross-chunk PK checks are reserved for S4', () => {
    const line =
        canonical({ entity: 'products', row: { product_id: 'fixture' } }) +
        '\n',
      bytes = Buffer.from(line + line);
    expect(() =>
      validateChunk(bytes, {
        index: 0,
        entity: 'products',
        file: '000000-products.ndjson',
        bytes: bytes.length,
        rows: 2,
        sha256: sha256(bytes),
      }),
    ).toThrow();
  });
  test('only explicit S1 transport entities, including sidecars and no fabricated conflict history', () => {
    expect(RECOVERY_ENTITIES).toContain('inventory_item_discards');
    expect(RECOVERY_ENTITIES).toContain('sale_adjustment_evidence');
    expect(RECOVERY_ENTITIES).toContain('event_provenance');
    expect(RECOVERY_ENTITIES).toContain('projection_provenance');
    expect(RECOVERY_ENTITIES).not.toContain('sync_conflicts');
    expect(RECOVERY_ENTITIES).not.toContain('sync_conflict_participants');
    expect(RECOVERY_ENTITIES).not.toContain('quotations');
  });
  test('invalid UTF8 never normalizes into admissible NDJSON', () => {
    const bytes = Buffer.concat([
      Buffer.from('{"entity":"products","row":{"x":"'),
      Buffer.from([255]),
      Buffer.from('"}}\n'),
    ]);
    expect(() =>
      validateChunk(bytes, {
        index: 0,
        entity: 'products',
        file: '000000-products.ndjson',
        bytes: bytes.length,
        rows: 1,
        sha256: sha256(bytes),
      }),
    ).toThrow();
  });
  test('manifest bound and buffer shape fail explicitly', () => {
    expect(() => parseManifest({} as Buffer)).toThrow();
    expect(() => parseManifest(Buffer.alloc(16777217))).toThrow();
  });
  test.each([
    [null, null, true],
    ['12', null, true],
    [null, '2026-11-08T00:00:00.000Z', false],
    ['21', null, false],
  ])(
    'unknown full-pull checkpoint preserves uncertainty (%p, %p)',
    (sequence, at, accepted) => {
      const manifest = {
        format: 'pos-server-recovery/1',
        package_id: '00000000-0000-4000-8000-000000000001',
        cut_at: '2026-11-08T00:00:00.000Z',
        source: {
          mode: 'server_sync',
          device_id: 'fixture',
          server_instance_id: null,
          generation_id: null,
          identity_provenance: 'legacy_unknown',
          schema_version: 10,
          schema_fingerprint: '0'.repeat(64),
          app_revision: 'fixture',
        },
        checkpoint: {
          last_full_pull_sequence: sequence,
          last_full_pull_at: at,
        },
        baseline_high_watermark: '20',
        contracts: {
          recovery: 1,
          bootstrap: 1,
          sale_adjustments: 1,
          pricing: [1, 2],
        },
        eligibility: { pending: 0, failed: 0, unresolved_incidents: 0 },
        coverage: {
          global_completeness: 'unknown',
          dependency_closure: 'unchecked',
        },
        exclusions: [],
        chunks: [],
      };
      const parse = () => parseManifest(Buffer.from(canonical(manifest)));
      if (accepted) expect(parse().checkpoint).toEqual(manifest.checkpoint);
      else expect(parse).toThrow();
    },
  );
});
