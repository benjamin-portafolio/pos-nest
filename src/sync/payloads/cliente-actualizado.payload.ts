import { ClienteCreadoPayload } from './cliente-creado.payload';
import { requiredUuidV4 } from './inventory-movement.payload';

export class ClienteActualizadoPayload {
  static readonly aggregateType = 'cliente';
  static readonly eventType = 'cliente_actualizado';
  private constructor(
    readonly baseEventId: string,
    readonly before: ClienteCreadoPayload,
    readonly after: ClienteCreadoPayload,
  ) {}
  static fromJson(json: Record<string, unknown>): ClienteActualizadoPayload {
    const baseEventId = requiredUuidV4(json.base_event_id, 'base_event_id');
    for (const key of ['before', 'after']) {
      if (
        !json[key] ||
        typeof json[key] !== 'object' ||
        Array.isArray(json[key])
      ) {
        throw new Error('Actualización de cliente inválida.');
      }
    }
    return new ClienteActualizadoPayload(
      baseEventId,
      ClienteCreadoPayload.fromJson(json.before as Record<string, unknown>),
      ClienteCreadoPayload.fromJson(json.after as Record<string, unknown>),
    );
  }
  toJson(): Record<string, unknown> {
    return {
      base_event_id: this.baseEventId,
      before: this.before.toJson(),
      after: this.after.toJson(),
    };
  }
}
