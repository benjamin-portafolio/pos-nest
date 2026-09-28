import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { SyncProjectionEntity } from './sync-projection.entity';
import { FinancialCategoryEntity } from './financial-category.entity';

/** Registro real de ingreso/gasto adicional. No duplica cobros de venta ni abonos. */
@Entity({ name: 'financial_entries' })
@Index('ix_financial_entries_period', ['occurredAtMs', 'id'])
@Index('ix_financial_entries_category', ['categoryId', 'occurredAtMs', 'id'])
@Check(
  'ck_financial_entries_category_name',
  'char_length(category_name_snapshot) BETWEEN 1 AND 100',
)
@Check('ck_financial_entries_direction', "direction IN ('in', 'out')")
@Check(
  'ck_financial_entries_nature',
  "nature IN ('operating', 'capital', 'asset_purchase', 'inventory_purchase', 'financing')",
)
@Check(
  'ck_financial_entries_nature_direction',
  "NOT (direction = 'in' AND nature IN ('asset_purchase', 'inventory_purchase'))",
)
@Check(
  'ck_financial_entries_amount',
  'amount_minor > 0 AND amount_minor <= 9007199254740991',
)
@Check('ck_financial_entries_currency', "currency = 'MXN'")
@Check('ck_financial_entries_method', "method IN ('cash', 'transfer')")
@Check(
  'ck_financial_entries_occurred',
  'occurred_at_ms > 0 AND occurred_at_ms <= 9007199254740991',
)
@Check(
  'ck_financial_entries_notes',
  'notes IS NULL OR char_length(notes) <= 500',
)
@Check(
  'ck_financial_entries_reference',
  'reference IS NULL OR char_length(reference) <= 500',
)
export class FinancialEntryEntity extends SyncProjectionEntity {
  /** UUID v4 de captura, estable en reintentos de la misma intención. */
  @PrimaryColumn('uuid')
  id: string;

  /** Categoría financiera referenciada; RESTRICT protege los registros. */
  @Column('uuid', { name: 'category_id' })
  categoryId: string;

  @ManyToOne(() => FinancialCategoryEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'category_id' })
  category: FinancialCategoryEntity;

  /** Snapshot del nombre de la categoría al capturar. */
  @Column({ type: 'varchar', length: 100, name: 'category_name_snapshot' })
  categoryNameSnapshot: string;

  /** Snapshot de dirección validado contra la categoría al aplicar. */
  @Column('text')
  direction: string;

  /** Snapshot de naturaleza validado contra la categoría al aplicar. */
  @Column('text')
  nature: string;

  /** Importe en centavos, positivo y dentro del entero seguro. */
  @Column('bigint', { name: 'amount_minor' })
  amountMinor: string;

  /** Moneda fija MXN. */
  @Column({ type: 'varchar', length: 3 })
  currency: string;

  /**
   * Medio cash/transfer.
   *
   * En el cajón no implica nada: `cash-event.handler.ts:75` rechaza que un
   * origen `transfer` genere movimiento de caja. En la cuenta bancaria sí tiene
   * consecuencia, porque alimenta el saldo estimado. Son dos cosas distintas.
   */
  @Column('text')
  method: string;

  /** Instante efectivo UTC en ms, separado de created_at_local y server_sequence. */
  @Column('bigint', { name: 'occurred_at_ms' })
  occurredAtMs: string;

  /** Nota opcional normalizada, máximo 500 code points. */
  @Column('text', { nullable: true })
  notes: string | null;

  /** Referencia opcional normalizada, máximo 500 code points. */
  @Column('text', { nullable: true })
  reference: string | null;
}