import { Check, Column, Entity, PrimaryColumn, Unique } from 'typeorm';

@Entity({ name: 'units' })
@Unique('ux_units_code', ['code'])
@Check('ck_units_dimension', `"dimension" IN ('count', 'mass', 'volume')`)
@Check('ck_units_atomic_factor', '"atomic_factor" > 0')
@Check(
  'ck_units_fraction_digits',
  '"max_fraction_digits" >= 0 AND "max_fraction_digits" <= 9',
)
export class UnitEntity {
  @PrimaryColumn('uuid', { name: 'unit_id' })
  unitId: string;

  @Column({ type: 'varchar', length: 24 })
  code: string;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'varchar', length: 16 })
  symbol: string;

  @Column({ type: 'varchar', length: 16 })
  dimension: string;

  @Column({ name: 'atomic_factor', type: 'bigint' })
  atomicFactor: string;

  @Column({ name: 'max_fraction_digits', type: 'integer' })
  maxFractionDigits: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;
}
