import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aditiva: no reescribe caja ni historial. El rango de `amount_minor` abre el
 * minimo a negativo de forma deliberada, porque una cuenta sobregirada es una
 * declaracion legitima; es la unica divergencia frente al resto del esquema.
 */
export class CreateAccountBalanceBaselines1790424000000
  implements MigrationInterface
{
  async up(r: QueryRunner): Promise<void> {
    const common = `active boolean NOT NULL DEFAULT true, version integer NOT NULL DEFAULT 1,
      created_event_id uuid, last_event_id uuid, last_server_sequence bigint,
      created_at_server timestamptz(3) NOT NULL DEFAULT now(), updated_at_server timestamptz(3) NOT NULL DEFAULT now()`;
    await r.query(`CREATE TABLE account_balance_baselines (id uuid PRIMARY KEY, ${common},
      device_id text NOT NULL, declared_by_user_id text NOT NULL,
      amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN -9007199254740991 AND 9007199254740991),
      as_of_ms bigint NOT NULL CHECK(as_of_ms BETWEEN 1 AND 9007199254740991))`);
    // El slot es global y único: el índice lo garantiza aunque dos declaraciones
    // lleguen a la vez, en el mismo lugar donde caja asegura una sola sesión
    // abierta por terminal.
    await r.query(
      'CREATE UNIQUE INDEX uq_account_balance_slot ON account_balance_baselines(active) WHERE active',
    );
  }
  async down(r: QueryRunner): Promise<void> {
    const rows = (await r.query(
      'SELECT EXISTS(SELECT 1 FROM account_balance_baselines) AS populated',
    )) as { populated: boolean }[];
    if (rows[0].populated)
      throw new Error('No se puede retirar el saldo declarado con historial.');
    await r.query('DROP TABLE account_balance_baselines');
  }
}
