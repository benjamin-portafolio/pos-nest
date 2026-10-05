import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { InventoryItemEntity } from './inventory-item.entity';
import { ProductVariantEntity } from './product-variant.entity';

/**
 * Último recurso de inventario directo conocido por una variante.
 *
 * Proyección auxiliar derivada de los eventos de producto. Permite recuperar
 * la identidad, el saldo y el historial anteriores al reactivar el seguimiento
 * directo sin releer todo el historial en cada consulta.
 *
 * No extiende `SyncProjectionEntity` porque cada fila es un dato derivado y
 * reemplazable del agregado producto/variante, sin ciclo de vida ni versión
 * propios: su identidad es la variante y la concurrencia la serializa el lock
 * del producto. No lleva `active` porque una memoria no se anula; se sustituye
 * cuando aparece un vínculo directo nuevo o recuperado, y se elimina cuando el
 * recurso se descarta.
 *
 * No reserva existencias: no participa del saldo, no habilita consumo y no se
 * usa para cobrar una venta. La configuración de venta capturada sigue siendo
 * la única fuente de consumo histórico.
 *
 * Cascadas (contrato rev. 1 §5.2): borrar el recurso elimina **solo** su
 * memoria, nunca la variante; borrar la variante elimina **solo** su memoria,
 * nunca el recurso. No hay unicidad sobre `inventory_item_id` porque el índice
 * solo permite detectar memorias de otras variantes.
 */
@Entity({ name: 'variant_inventory_memory' })
@Index('ix_variant_inventory_memory_item', ['inventoryItemId'])
export class VariantInventoryMemoryEntity {
  @PrimaryColumn('uuid', {
    name: 'variant_id',
    primaryKeyConstraintName: 'pk_variant_inventory_memory',
    comment: 'Variante que recuerda el recurso.',
  })
  variantId: string;

  @ManyToOne(() => ProductVariantEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'variant_id',
    foreignKeyConstraintName: 'fk_variant_inventory_memory_variant',
  })
  variant: ProductVariantEntity;

  @Column('uuid', {
    name: 'inventory_item_id',
    comment: 'Último recurso directo conocido de la variante.',
  })
  inventoryItemId: string;

  @ManyToOne(() => InventoryItemEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'inventory_item_id',
    foreignKeyConstraintName: 'fk_variant_inventory_memory_inventory_item',
  })
  inventoryItem: InventoryItemEntity;

  /**
   * Evento de producto cuya configuración acreditó esta memoria: el que
   * estableció el vínculo o el que lo quitó conservando el recurso.
   *
   * No es una FK al historial de eventos: `events` se conserva por otros
   * caminos y esta fila debe poder reconstruirse cuando la evidencia local no
   * está disponible.
   */
  @Column({
    name: 'source_event_id',
    type: 'uuid',
    comment:
      'Evento de producto que acreditó la memoria; no es FK al historial.',
  })
  sourceEventId: string;

  /**
   * Secuencia oficial del evento acreditado. Null mientras el estado es solo
   * local; permite reconocer un eco sin sobrescribir una memoria posterior.
   */
  @Column({
    name: 'source_server_sequence',
    type: 'bigint',
    nullable: true,
    comment: 'Secuencia oficial del evento acreditado; null si es solo local.',
  })
  sourceServerSequence: string | null;
}
