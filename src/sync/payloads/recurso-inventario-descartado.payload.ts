import { requiredUuidV4 } from './inventory-movement.payload';
import { RecursoInventarioCreadoPayload } from './recurso-inventario-creado.payload';

/**
 * Descarte de un recurso de inventario autogenerado y realmente vacío.
 *
 * Contrato de evento propio del contrato rev. 1 §6.3. Solo existe para
 * `standalone`: se emite con `delivery_status = not_required`, el servidor lo
 * rechaza funcionalmente sin borrar nada y no lo distribuye por pull. Por eso
 * este lado no declara referencias `LocalEventRef`: el push no transporta refs
 * y el servidor no registra el evento como emisor.
 */
export class RecursoInventarioDescartadoPayload {
  static readonly aggregateType = 'inventory_item';
  static readonly eventType = 'recurso_inventario_descartado';

  /**
   * Única versión de política admitida. Un valor distinto se rechaza en el
   * contrato, antes de evaluar elegibilidad o borrar nada.
   */
  static readonly supportedPolicyVersion = 1;

  /** Estado de entrega obligatorio: el descarte nunca se envía al servidor. */
  static readonly deliveryStatus = 'not_required';

  constructor(
    /** Evento que creó el recurso; acredita versión y secuencia base. */
    readonly baseEventId: string,
    /** Producto responsable de la desvinculación que habilitó el descarte. */
    readonly triggerProductId: string,
    /**
     * Evento de producto aplicado que quitó el vínculo de `originVariantId`.
     * No puede ser el alta del recurso: son eventos de agregados distintos.
     */
    readonly triggerProductEventId: string,
    /**
     * Procedencia comprobada del recurso, igual a la variante desvinculada.
     * Aquí es obligatoria: sin procedencia explícita no hay descarte posible.
     */
    readonly originVariantId: string,
    /** Versión de la política de descarte que evalúa la elegibilidad. */
    readonly policyVersion: number,
  ) {}

  static fromJson(
    payload: Record<string, unknown>,
  ): RecursoInventarioDescartadoPayload {
    const allowed = new Set([
      'base_event_id',
      'trigger_product_id',
      'trigger_product_event_id',
      RecursoInventarioCreadoPayload.originVariantIdField,
      'policy_version',
    ]);
    const unexpected = Object.keys(payload).filter((key) => !allowed.has(key));
    if (unexpected.length > 0) {
      throw new Error(
        `${RecursoInventarioDescartadoPayload.eventType} contiene campos no permitidos: ${unexpected.join(', ')}.`,
      );
    }
    return RecursoInventarioDescartadoPayload.create(payload);
  }

  static create(
    payload: Record<string, unknown>,
  ): RecursoInventarioDescartadoPayload {
    const policyVersion = payload.policy_version;
    if (
      typeof policyVersion !== 'number' ||
      !Number.isSafeInteger(policyVersion)
    ) {
      throw new Error('policy_version debe ser un entero.');
    }
    if (
      policyVersion !==
      RecursoInventarioDescartadoPayload.supportedPolicyVersion
    ) {
      throw new Error(
        `policy_version solo admite ${RecursoInventarioDescartadoPayload.supportedPolicyVersion}.`,
      );
    }
    const baseEventId = requiredUuidV4(payload.base_event_id, 'base_event_id');
    const triggerProductEventId = requiredUuidV4(
      payload.trigger_product_event_id,
      'trigger_product_event_id',
    );
    if (baseEventId === triggerProductEventId) {
      throw new Error(
        'El disparador del descarte no puede ser el alta del recurso.',
      );
    }
    return new RecursoInventarioDescartadoPayload(
      baseEventId,
      requiredUuidV4(payload.trigger_product_id, 'trigger_product_id'),
      triggerProductEventId,
      requiredUuidV4(
        payload[RecursoInventarioCreadoPayload.originVariantIdField],
        RecursoInventarioCreadoPayload.originVariantIdField,
      ),
      policyVersion,
    );
  }

  toJson(): Record<string, unknown> {
    return {
      base_event_id: this.baseEventId,
      trigger_product_id: this.triggerProductId,
      trigger_product_event_id: this.triggerProductEventId,
      [RecursoInventarioCreadoPayload.originVariantIdField]:
        this.originVariantId,
      policy_version: this.policyVersion,
    };
  }
}
