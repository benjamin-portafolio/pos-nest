import { MigrationInterface, QueryRunner } from 'typeorm';

/** Durable private baseline. No automatic migration or business schema relaxation. */
export class CreateRecoveryDataset1794182400000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      'SELECT singleton FROM server_state WHERE singleton FOR UPDATE',
    );
    const [sequence] = await q.query(
      "SELECT pg_get_serial_sequence('events','server_sequence') AS name",
    );
    if (!sequence?.name)
      throw new Error('Recovery requires the event sequence generator');
    const identifier = sequence.name
      .split('.')
      .map((part: string) => '"' + part.replace(/"/g, '') + '"')
      .join('.');
    await q.query(`ALTER SEQUENCE ${identifier} MAXVALUE 9007199254740991`);
    await q.query(`CREATE TABLE recovery_rows (
      recovery_id uuid NOT NULL REFERENCES recovery_sessions(recovery_id),
      entity text NOT NULL, row_key text NOT NULL, row_data jsonb NOT NULL,
      PRIMARY KEY(recovery_id,entity,row_key)
    )`);
    await q.query(`CREATE TABLE recovery_datasets (
      dataset_id uuid PRIMARY KEY, recovery_id uuid NOT NULL UNIQUE REFERENCES recovery_sessions(recovery_id),
      generation_id uuid NOT NULL, manifest_bytes bytea NOT NULL, digest char(64) NOT NULL,
      summary jsonb NOT NULL, imported_at timestamptz NOT NULL
    )`);
    await q.query(`CREATE TABLE recovery_dataset_chunks (
      dataset_id uuid NOT NULL REFERENCES recovery_datasets(dataset_id),
      chunk_index integer NOT NULL, content bytea NOT NULL CHECK(octet_length(content)<=4194304),
      PRIMARY KEY(dataset_id,chunk_index)
    )`);
    await q.query(`CREATE TABLE recovery_bootstrap_grants (
      token_hash char(64) PRIMARY KEY, server_instance_id uuid NOT NULL,
      generation_id uuid NOT NULL, dataset_id uuid NOT NULL REFERENCES recovery_datasets(dataset_id),
      expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false,
      device_id text UNIQUE, issuer text NOT NULL, recipient text NOT NULL
    )`);
  }
  async down(q: QueryRunner): Promise<void> {
    const [r] = await q.query(
      'SELECT count(*)::int AS count FROM recovery_datasets',
    );
    if (r.count) throw new Error('Cannot remove published recovery datasets');
    const [sequence] = await q.query(
      "SELECT pg_get_serial_sequence('events','server_sequence') AS name",
    );
    const identifier = sequence.name
      .split('.')
      .map((part: string) => '"' + part.replace(/"/g, '') + '"')
      .join('.');
    await q.query(`ALTER SEQUENCE ${identifier} NO MAXVALUE`);
    await q.query(
      'DROP TABLE recovery_bootstrap_grants,recovery_dataset_chunks,recovery_datasets,recovery_rows',
    );
  }
}
