import { OperacionVentaConciliadaPayload } from './operacion-venta-conciliada.payload';
import { isDeepStrictEqual } from 'util';
import { EventEntity } from '../../entities/event.entity';
import { PushEventDto } from '../dto/push-events.dto';
import { VentaAnuladaPayload } from './venta-anulada.payload';
import { DevolucionVentaRegistradaPayload } from './devolucion-venta-registrada.payload';
export function isSaleAdjustment(type: string): boolean {
  return [
    OperacionVentaConciliadaPayload.eventType,
    VentaAnuladaPayload.eventType,
    DevolucionVentaRegistradaPayload.eventType,
  ].includes(type);
}
function canonical(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  try {
    if(type === OperacionVentaConciliadaPayload.eventType) return OperacionVentaConciliadaPayload.fromJson(payload).toJson();
    return type === VentaAnuladaPayload.eventType
      ? VentaAnuladaPayload.fromJson(payload).toJson()
      : DevolucionVentaRegistradaPayload.fromJson(payload).toJson();
  } catch {
    return payload;
  }
}
/** La base oficial efectiva y la secuencia local son metadatos de transporte. */
export function adjustmentDuplicateMatches(
  e: PushEventDto,
  old: EventEntity,
): boolean {
  if (!isSaleAdjustment(e.event_type) && !isSaleAdjustment(old.eventType))
    return true;
  return (
    e.event_type === old.eventType &&
    e.aggregate_type === old.aggregateType &&
    e.aggregate_id === old.aggregateId &&
    e.device_id === old.deviceId &&
    e.user_id === old.userId &&
    e.base_version === old.baseVersion &&
    new Date(e.created_at_local).getTime() === old.createdAtLocal.getTime() &&
    isDeepStrictEqual(
      canonical(e.event_type, e.payload),
      canonical(old.eventType, old.payload),
    )
  );
}
