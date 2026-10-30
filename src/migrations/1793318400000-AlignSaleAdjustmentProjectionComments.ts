import { MigrationInterface, QueryRunner } from 'typeorm';

/** Completa la documentación heredada sin cambiar operaciones ni restricciones. */
export class AlignSaleAdjustmentProjectionComments1793318400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      COMMENT ON COLUMN sale_adjustments.active IS 'Indica si la proyeccion esta activa.';
      COMMENT ON COLUMN sale_adjustments.version IS 'Version de la proyeccion para concurrencia optimista.';
      COMMENT ON COLUMN sale_adjustments.created_event_id IS 'Evento que creo la proyeccion.';
      COMMENT ON COLUMN sale_adjustments.last_event_id IS 'Ultimo evento aplicado a la proyeccion.';
      COMMENT ON COLUMN sale_adjustments.last_server_sequence IS 'Ultima secuencia de servidor aplicada a la proyeccion.';
      COMMENT ON COLUMN sale_adjustments.created_at_server IS 'Fecha en que el servidor creo la proyeccion.';
      COMMENT ON COLUMN sale_adjustments.updated_at_server IS 'Fecha de ultima actualizacion de la proyeccion.';
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const column of [
      'active',
      'version',
      'created_event_id',
      'last_event_id',
      'last_server_sequence',
      'created_at_server',
      'updated_at_server',
    ]) {
      await runner.query(
        `COMMENT ON COLUMN sale_adjustments.${column} IS NULL`,
      );
    }
  }
}
