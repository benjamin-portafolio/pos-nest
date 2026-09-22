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
export class SaleEntity extends SyncProjectionEntity {
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
