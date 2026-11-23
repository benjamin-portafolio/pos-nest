import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BUSINESS_TABLES, TECHNICAL_TABLES } from './recovery-schema';
/** Enforce a restricted runtime role, with an explicit local development exception. */
@Injectable()
export class RecoveryRuntimePolicyService implements OnModuleInit {
  private readonly logger = new Logger(RecoveryRuntimePolicyService.name);

  constructor(private readonly db: DataSource) {}
  async onModuleInit() {
    const [role] = await this.db.query(
      "SELECT bool_or(rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS privileged FROM pg_roles WHERE pg_has_role(current_user,oid,'MEMBER')",
    );
    const owned = await this.db.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND pg_has_role(current_user,c.relowner,'MEMBER')`,
      [[...BUSINESS_TABLES, ...TECHNICAL_TABLES]],
    );
    const [ddl] = await this.db.query(
      "SELECT has_schema_privilege(current_schema(),'CREATE') AS allowed",
    );
    const unsafeRole =
      Object.values(role).some(Boolean) || owned.length > 0 || ddl.allowed;
    const allowUnsafeRole =
      process.env.NODE_ENV === 'development' &&
      process.env.POS_ALLOW_UNSAFE_DB_ROLE === '1';
    if (unsafeRole) {
      if (!allowUnsafeRole)
        throw new Error(
          'Unsafe runtime PostgreSQL role: require non-owner, no privileged memberships or schema CREATE; use a separate migration operator',
        );
      this.logger.warn(
        'Privileged PostgreSQL role allowed for development by POS_ALLOW_UNSAFE_DB_ROLE=1; database recovery protections can be bypassed by this role',
      );
    }
    const [datasetSchema] = await this.db.query(
      "SELECT to_regclass('recovery_rows') IS NOT NULL AND to_regclass('recovery_datasets') IS NOT NULL AND to_regclass('recovery_dataset_chunks') IS NOT NULL AND to_regclass('recovery_bootstrap_grants') IS NOT NULL AS installed",
    );
    if (!datasetSchema.installed)
      throw new Error(
        'Recovery dataset migration missing; apply explicitly before starting',
      );
    const [connectionSchema] = await this.db.query(
      "SELECT to_regclass('recovery_connection_requests') IS NOT NULL AS installed",
    );
    if (!connectionSchema.installed)
      throw new Error(
        'Connection request migration missing; apply explicitly before starting',
      );
    const [state] = await this.db.query(
      'SELECT singleton, automatic_enrollment FROM server_state WHERE singleton',
    );
    if (!state)
      throw new Error(
        'Recovery migration/control missing; apply explicitly before starting',
      );
  }
}
