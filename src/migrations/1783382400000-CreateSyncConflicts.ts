import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSyncConflicts1783382400000 implements MigrationInterface {
  name = 'CreateSyncConflicts1783382400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await queryRunner.query(`
      CREATE TYPE "sync_conflict_status" AS ENUM (
        'open',
        'acknowledged',
        'resolved',
        'ignored'
      )
    `);
    await queryRunner.query(`
      CREATE TYPE "sync_conflict_participant_role" AS ENUM (
        'default_winner',
        'contender'
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "sync_conflicts" (
        "conflict_id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "conflict_type" varchar(80) NOT NULL,
        "ref_type" varchar(80) NOT NULL,
        "ref_id" varchar(180) NOT NULL,
        "status" "sync_conflict_status" NOT NULL DEFAULT 'open',
        "default_winner_event_id" uuid,
        "resolution_event_id" uuid,
        "reason" text,
        "created_at_server" timestamptz(3) NOT NULL DEFAULT now(),
        "updated_at_server" timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT "pk_sync_conflicts" PRIMARY KEY ("conflict_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "sync_conflict_participants" (
        "participant_id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "conflict_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "participant_role" "sync_conflict_participant_role" NOT NULL,
        "aggregate_type" varchar(80) NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "event_type" varchar(120) NOT NULL,
        "sync_status" varchar(40) NOT NULL,
        "server_sequence" bigint,
        "reason" text,
        "created_at_server" timestamptz(3) NOT NULL DEFAULT now(),
        CONSTRAINT "pk_sync_conflict_participants" PRIMARY KEY ("participant_id")
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "ix_sync_conflicts_status" ON "sync_conflicts" ("status")',
    );
    await queryRunner.query(
      'CREATE INDEX "ix_sync_conflicts_ref" ON "sync_conflicts" ("conflict_type", "ref_type", "ref_id")',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX "ux_sync_conflict_participants_conflict_event" ON "sync_conflict_participants" ("conflict_id", "event_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "ix_sync_conflict_participants_event" ON "sync_conflict_participants" ("event_id")',
    );
    await queryRunner.query(
      'CREATE INDEX "ix_sync_conflict_participants_aggregate" ON "sync_conflict_participants" ("aggregate_type", "aggregate_id")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX "ix_sync_conflict_participants_aggregate"',
    );
    await queryRunner.query('DROP INDEX "ix_sync_conflict_participants_event"');
    await queryRunner.query(
      'DROP INDEX "ux_sync_conflict_participants_conflict_event"',
    );
    await queryRunner.query('DROP INDEX "ix_sync_conflicts_ref"');
    await queryRunner.query('DROP INDEX "ix_sync_conflicts_status"');
    await queryRunner.query('DROP TABLE "sync_conflict_participants"');
    await queryRunner.query('DROP TABLE "sync_conflicts"');
    await queryRunner.query('DROP TYPE "sync_conflict_participant_role"');
    await queryRunner.query('DROP TYPE "sync_conflict_status"');
  }
}
