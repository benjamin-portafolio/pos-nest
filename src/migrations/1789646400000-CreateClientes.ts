import { MigrationInterface, QueryRunner } from 'typeorm';

/** Alta de clientes sin modificar los catálogos existentes. */
export class CreateClientes1789646400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE clientes (
      cliente_id uuid PRIMARY KEY,
      nombre text NOT NULL,
      telefono text,
      active boolean NOT NULL DEFAULT true,
      version integer NOT NULL DEFAULT 1,
      created_event_id uuid,
      last_event_id uuid,
      last_server_sequence bigint,
      created_at_server timestamptz(3) NOT NULL DEFAULT now(),
      updated_at_server timestamptz(3) NOT NULL DEFAULT now(),
      CONSTRAINT ck_clientes_nombre CHECK(length(trim(nombre)) > 0)
    )`);
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = (await runner.query(
      'SELECT EXISTS(SELECT 1 FROM clientes) AS populated',
    )) as { populated: boolean }[];
    if (rows[0].populated)
      throw new Error('No se puede retirar la tabla con clientes registrados.');
    await runner.query('DROP TABLE clientes');
  }
}
