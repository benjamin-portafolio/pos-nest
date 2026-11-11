import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateConnectionAttempts1794355200000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      'ALTER TABLE server_state ADD COLUMN automatic_enrollment boolean NOT NULL DEFAULT false',
    );
    await q.query(`CREATE TABLE recovery_connection_requests (
      request_id uuid PRIMARY KEY,
      proof_hash char(64) NOT NULL,
      server_instance_id uuid NOT NULL,
      generation_id uuid NOT NULL,
      package_id uuid NOT NULL,
      manifest_digest char(64) NOT NULL,
      source_device_id text NOT NULL,
      decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected')),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE recovery_connection_requests');
    await q.query('ALTER TABLE server_state DROP COLUMN automatic_enrollment');
  }
}
