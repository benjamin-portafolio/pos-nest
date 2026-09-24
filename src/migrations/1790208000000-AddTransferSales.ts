import { MigrationInterface, QueryRunner } from 'typeorm';

/** Ejecutar explícitamente antes de habilitar transferencias en las tablets. */
export class AddTransferSales1790208000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE sale_payments ADD COLUMN reference varchar(500)',
    );
    await runner.query(`ALTER TABLE sale_payments ADD CONSTRAINT ck_direct_payment_method
      CHECK(method IN ('cash', 'transfer') AND currency = 'MXN' AND
        (method <> 'transfer' OR (received_minor = amount_minor AND change_minor = 0)))`);
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows = (await runner.query(`SELECT EXISTS(SELECT 1 FROM sale_payments
      WHERE method <> 'cash' OR reference IS NOT NULL) AS occupied`)) as {
      occupied: boolean;
    }[];
    if (rows[0].occupied)
      throw new Error(
        'No se puede retirar el esquema con transferencias o referencias.',
      );
    await runner.query(
      'ALTER TABLE sale_payments DROP CONSTRAINT ck_direct_payment_method',
    );
    await runner.query('ALTER TABLE sale_payments DROP COLUMN reference');
  }
}
