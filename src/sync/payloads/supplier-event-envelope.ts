import { PushEventDto } from '../dto/push-events.dto';
import { SupplierJson } from './supplier-json';

/** El cursor del sobre admite la representación decimal del DTO, sin pérdida. */
export function supplierBaseSequence(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'string' && /^[0-9]+$/.test(value))
    return SupplierJson.integer(Number(value), 'base_server_sequence');
  return SupplierJson.integer(value, 'base_server_sequence');
}
export function supplierEnvelopeError(event: PushEventDto): string | null {
  try {
    SupplierJson.uuid(event.event_id, 'event_id');
    SupplierJson.uuid(event.aggregate_id, 'aggregate_id');
    for (const [field, limit] of [
      ['aggregate_type', 80],
      ['event_type', 120],
    ] as const) {
      SupplierJson.requiredText(event[field], field);
      if (event[field].length > limit)
        throw new Error(`${field} excede ${limit} caracteres.`);
    }
    for (const field of ['device_id', 'user_id'] as const) {
      SupplierJson.requiredText(event[field], field);
      if (event[field].length > 120)
        throw new Error(`${field} excede 120 caracteres.`);
    }
    if (
      typeof event.created_at_local !== 'string' ||
      !Number.isFinite(new Date(event.created_at_local).getTime())
    )
      throw new Error('created_at_local no es una fecha válida.');
    if (
      event.local_sequence != null &&
      SupplierJson.integer(event.local_sequence, 'local_sequence') > 2147483647
    )
      throw new Error('local_sequence fuera del rango PostgreSQL.');
    if (
      SupplierJson.integer(event.base_version, 'base_version', 1) >= 2147483647
    )
      throw new Error('base_version fuera del rango PostgreSQL.');
    supplierBaseSequence(event.base_server_sequence);
    SupplierJson.object(event.payload, 'payload');
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
