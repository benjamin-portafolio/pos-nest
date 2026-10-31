import {
  Check,
  Column,
  Entity,
  PrimaryColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ClienteEntity } from './cliente.entity';
import { SyncProjectionEntity } from './sync-projection.entity';
@Entity({ name: 'sales' })
@Check('ck_sales_total', '"total_minor" BETWEEN 0 AND 9007199254740991')
@Check(
  'ck_sales_pricing',
  "(pricing_contract_version IS NULL AND pricing_mode IS NULL) OR (pricing_contract_version IS NOT NULL AND pricing_contract_version = 2 AND pricing_mode IS NOT NULL AND pricing_mode IN ('normal','offer'))",
)
export class SaleEntity extends SyncProjectionEntity {
  @Column({ name: 'pricing_contract_version', type: 'integer', nullable: true })
  pricingContractVersion: number | null;
  @Column({ name: 'pricing_mode', type: 'varchar', nullable: true })
  pricingMode: string | null;
  @Column('uuid', { name: 'cliente_id', nullable: true }) clienteId:
    | string
    | null;
  @ManyToOne(() => ClienteEntity, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'cliente_id' })
  cliente: ClienteEntity | null;
  @PrimaryColumn('uuid', { name: 'sale_id' }) id: string;
  @Column({ name: 'user_id', type: 'varchar', length: 120 }) userId: string;
  @Column({ name: 'device_id', type: 'varchar', length: 120 }) deviceId: string;
  @Column({ type: 'varchar', default: 'confirmada' }) status: string;
  @Column({ name: 'total_minor', type: 'bigint' }) totalMinor: string;
  @Column({ type: 'varchar', length: 3 }) currency: string;
  @Column({ name: 'created_at_local', type: 'timestamptz' })
  createdAtLocal: Date;
}
