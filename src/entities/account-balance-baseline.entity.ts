import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';

/**
 * Saldo inicial declarado de la cuenta bancaria: un hecho unico, inmutable y sin
 * sesion. No hay `status` operativo ni columnas de cierre; la fila existe o no
 * existe. Sin `account_id` (fuera de alcance explicito): el slot unico lo
 * resuelve la referencia `requires_unique` de `account_balance_slot`/`unica`.
 *
 * El indice unico parcial sobre la columna activa es la garantia de que el slot
 * es de verdad global, en el mismo lugar donde caja ensurea una sola sesion
 * abierta: no basta con que el handler lo compruebe, la base lo impide.
 */
@Entity({ name: 'account_balance_baselines' })
@Index('uq_account_balance_slot', ['active'], { unique: true, where: 'active' })
@Check('ck_account_balance_amount', 'amount_minor BETWEEN -9007199254740991 AND 9007199254740991')
@Check('ck_account_balance_as_of', 'as_of_ms BETWEEN 1 AND 9007199254740991')
export class AccountBalanceBaselineEntity extends SyncProjectionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('text', { name: 'device_id' }) deviceId: string;
  @Column('text', { name: 'declared_by_user_id' }) declaredByUserId: string;
  /** Saldo reportado por el banco. Admite negativo: una cuenta puede estar sobregirada. */
  @Column('bigint', { name: 'amount_minor' }) amountMinor: string;
  /** FRONTERA en ms: el saldo declarado cubre todo lo anterior a este instante. */
  @Column('bigint', { name: 'as_of_ms' }) asOfMs: string;
}
