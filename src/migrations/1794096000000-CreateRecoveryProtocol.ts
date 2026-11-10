import { randomUUID } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  BUSINESS_TABLES,
  SCHEMA_FINGERPRINT_SQL,
} from '../recovery/recovery-schema';

export class CreateRecoveryProtocol1794096000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    const [{ schema }] = await q.query('SELECT current_schema() AS schema');
    const namespace = '"' + String(schema).replace(/"/g, '""') + '"';
    // Explicit administrative migration; never run by application bootstrap.
    for (const table of BUSINESS_TABLES)
      await q.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
    await q.query(`CREATE TABLE server_state (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      server_instance_id uuid NOT NULL, generation_id uuid NOT NULL,
      mode text NOT NULL CHECK(mode IN ('empty','recovering','active')),
      active_recovery_id uuid, dataset_id uuid,
      baseline_high_watermark bigint NOT NULL DEFAULT 0 CHECK(baseline_high_watermark BETWEEN 0 AND 9007199254740991),
      revision integer NOT NULL DEFAULT 0, schema_fingerprint text NOT NULL,
      recovery_enabled boolean NOT NULL DEFAULT false
    )`);
    await q.query(
      `INSERT INTO server_state(server_instance_id,generation_id,mode,schema_fingerprint) VALUES($1,$2,'empty','installing')`,
      [randomUUID(), randomUUID()],
    );
    await q.query(`CREATE TABLE recovery_sessions (
      recovery_id uuid PRIMARY KEY, package_id uuid NOT NULL UNIQUE,
      manifest_digest char(64) NOT NULL, manifest_bytes bytea NOT NULL,
      source_device_id text NOT NULL, candidate_generation_id uuid NOT NULL,
      state text NOT NULL CHECK(state IN ('receiving','validating','failed_validation','ready_to_commit','completed','aborted')),
      revision integer NOT NULL DEFAULT 0, diagnostic jsonb, validation_digest char(64), receipt jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(
      `CREATE UNIQUE INDEX recovery_one_live ON recovery_sessions((true)) WHERE state IN ('receiving','validating','failed_validation','ready_to_commit')`,
    );
    await q.query(`CREATE TABLE recovery_chunks (
      recovery_id uuid NOT NULL REFERENCES recovery_sessions(recovery_id),
      chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 99999),
      digest char(64) NOT NULL, content bytea NOT NULL CHECK(octet_length(content)<=4194304),
      row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 1000),
      PRIMARY KEY(recovery_id,chunk_index)
    )`);
    await q.query(`CREATE TABLE recovery_authorizations (
      token_hash char(64) PRIMARY KEY, server_instance_id uuid NOT NULL,
      generation_id uuid NOT NULL, recovery_id uuid NOT NULL, package_id uuid NOT NULL,
      manifest_digest char(64) NOT NULL, source_device_id text NOT NULL,
      operations text[] NOT NULL, expires_at timestamptz NOT NULL,
      revoked boolean NOT NULL DEFAULT false, consumed boolean NOT NULL DEFAULT false,
      issuer text NOT NULL, recipient text NOT NULL
    )`);
    await q.query(`CREATE TABLE recovery_audit (
      id bigserial PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(),
      recovery_id uuid, action text NOT NULL, details jsonb NOT NULL
    )`);
    // No HTTP issuance in S2: only S4 may create a binding after real bootstrap.
    await q.query(`CREATE TABLE sync_bindings (
      token_hash char(64) PRIMARY KEY, server_instance_id uuid NOT NULL,
      generation_id uuid NOT NULL, dataset_id uuid NOT NULL, device_id text NOT NULL UNIQUE,
      bootstrap_digest char(64) NOT NULL, baseline_high_watermark bigint NOT NULL,
      expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
    )`);
    await q.query(`CREATE FUNCTION recovery_business_gate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,${namespace},pg_temp AS $$
      DECLARE current_mode text;
      BEGIN
        SELECT mode INTO STRICT current_mode FROM ${namespace}.server_state WHERE singleton FOR SHARE;
        IF current_mode='recovering' THEN RAISE EXCEPTION 'server_recovering' USING ERRCODE='55000'; END IF;
        RETURN NULL;
      END $$`);
    for (const table of BUSINESS_TABLES) {
      await q.query(
        `CREATE TRIGGER recovery_business_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION recovery_business_gate()`,
      );
    }
    const [fp] = await q.query(SCHEMA_FINGERPRINT_SQL, [BUSINESS_TABLES]);
    let occupied = false;
    for (const table of BUSINESS_TABLES.filter((t) => t !== 'units')) {
      const [r] = await q.query(
        `SELECT EXISTS(SELECT 1 FROM "${table}") AS occupied`,
      );
      occupied ||= r.occupied;
    }
    await q.query('UPDATE server_state SET schema_fingerprint=$1,mode=$2', [
      fp.fingerprint,
      occupied ? 'active' : 'empty',
    ]);
  }
  async down(q: QueryRunner): Promise<void> {
    const [state] = await q.query(
      'SELECT * FROM server_state WHERE singleton FOR UPDATE',
    );
    const [bindings] = await q.query(
      'SELECT count(*)::int AS count FROM sync_bindings',
    );
    const [sessions] = await q.query(
      "SELECT count(*)::int AS count FROM recovery_sessions WHERE state<>'aborted'",
    );
    if (
      state.mode !== 'empty' ||
      state.dataset_id ||
      bindings.count ||
      sessions.count
    )
      throw new Error(
        'Recovery downgrade requires empty destination, no dataset/bindings and only aborted sessions',
      );
    for (const table of BUSINESS_TABLES) {
      await q.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
      if (table !== 'units') {
        const [row] = await q.query(
          `SELECT EXISTS(SELECT 1 FROM "${table}") AS occupied`,
        );
        if (row.occupied)
          throw new Error(
            'Recovery downgrade cannot remove protection from business data',
          );
      }
      await q.query(`DROP TRIGGER recovery_business_gate ON "${table}"`);
    }
    await q.query('DROP FUNCTION recovery_business_gate()');
    await q.query(
      'DROP TABLE recovery_chunks,recovery_authorizations,recovery_audit,sync_bindings,recovery_sessions,server_state',
    );
  }
}
